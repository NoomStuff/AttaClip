"""Real ScreenCaptureKit capture of a synthetic window and its generated tone."""
import json
import os
import pathlib
import queue
import re
import subprocess
import sys
import threading
import time
import uuid

assert sys.platform == "darwin", "The Mac smoke test requires an actual macOS host"
root = pathlib.Path.cwd()
runtime = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else "resources/recorder").resolve()
folder = root / ".cache/macos-capture" / str(uuid.uuid4())
folder.mkdir(parents=True)
events = []
processes = []
logs = []
env = dict(os.environ, DYLD_LIBRARY_PATH=str(runtime / "Frameworks"), DYLD_FRAMEWORK_PATH=str(runtime / "Frameworks"))
ffmpeg = str(root / "resources/media/ffmpeg")
ffprobe = str(root / "resources/media/ffprobe")

def launch(args, name, pipe=False):
    log = open(folder / (name + ".log"), "w")
    logs.append(log)
    child = subprocess.Popen(args, cwd=root, env=env, stdin=subprocess.PIPE if pipe else subprocess.DEVNULL,
                             stdout=subprocess.PIPE if pipe else log, stderr=log, text=True)
    processes.append(child)
    return child

def wait(predicate, timeout=25):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        for event in events:
            if predicate(event):
                return event
        if helper.poll() is not None:
            raise RuntimeError(f"Recorder exited {helper.returncode}. Inspect {folder}")
        time.sleep(0.02)
    raise RuntimeError(f"Native command timed out. Events: {events}")

def command(data, expected="response"):
    identity = str(uuid.uuid4())
    helper.stdin.write(json.dumps(dict(data, id=identity)) + "\n")
    helper.stdin.flush()
    result = wait(lambda event: event.get("id") == identity)
    assert result["event"] == expected, result
    return result

def validate(file, audio_expected):
    result = subprocess.run([ffprobe, "-v", "error", "-show_streams", "-show_format", "-of", "json", str(file)], capture_output=True, text=True, check=True)
    info = json.loads(result.stdout)
    video = next(stream for stream in info["streams"] if stream["codec_type"] == "video")
    assert (video["width"], video["height"]) == (640, 360), video
    assert float(info["format"]["duration"]) >= 1.5, info["format"]
    audio = [stream for stream in info["streams"] if stream["codec_type"] == "audio"]
    assert len(audio) == 2, audio
    subprocess.run([ffmpeg, "-v", "error", "-i", str(file), "-map", "0", "-f", "null", "-"], check=True)
    pixels = []
    for position in (0.1, 0.4, 0.7, 1.1):
        pixel = subprocess.run([ffmpeg, "-v", "error", "-ss", str(position), "-i", str(file), "-vf", "crop=2:2:iw/2:ih/2,scale=1:1", "-frames:v", "1", "-pix_fmt", "rgb24", "-f", "rawvideo", "-"], capture_output=True, check=True).stdout
        assert len(pixel) == 3, pixel
        assert any(all(abs(pixel[i] - color[i]) <= 22 for i in range(3)) for color in ((228, 76, 102), (65, 184, 170))), pixel
        pixels.append(list(pixel))
    assert len(set(tuple(pixel) for pixel in pixels)) > 1, "Saved capture did not contain changing fixture frames"
    levels = []
    for track in range(2):
        result = subprocess.run([ffmpeg, "-hide_banner", "-i", str(file), "-map", f"0:a:{track}", "-af", "volumedetect", "-f", "null", "-"], capture_output=True, text=True, check=True)
        match = re.search(r"mean_volume: (-?[\d.]+) dB", result.stderr)
        assert match, result.stderr
        level = float(match[1])
        if audio_expected:
            assert level > -55, f"No generated application audio on track {track}: {level} dB"
        levels.append(level)
    return dict(path=str(file.relative_to(root)), pixels=pixels, audioMeanDB=levels, duration=float(info["format"]["duration"]))

try:
    fixture_binary = folder / "fixture"
    subprocess.run(["swiftc", str(root / "native/macos/fixture.swift"), "-o", str(fixture_binary)], check=True)
    fixture = launch([str(fixture_binary)], "fixture", True)
    # This fixture is its own process. SCK excludes recorder process audio only.
    first_line = queue.Queue()
    threading.Thread(target=lambda: first_line.put(fixture.stdout.readline()), daemon=True).start()
    try:
        identity = json.loads(first_line.get(timeout=20))
    except queue.Empty:
        raise RuntimeError("The synthetic Mac fixture did not start within 20 seconds")
    (folder / "fixture.json").write_text(json.dumps(identity, indent=2))
    assert identity["screenPermission"], "Hosted macOS runner has no Screen Recording permission"
    assert identity["audioStarted"], "The runner could not play the generated tone, so audio capture cannot be proven"
    fixture_health = []
    def read_fixture():
        for line in fixture.stdout:
            fixture_health.append(json.loads(line))
    threading.Thread(target=read_fixture, daemon=True).start()
    helper = launch([str(runtime / "attaclip-recorder"), str(runtime)], "native", True)
    def read():
        for line in helper.stdout:
            events.append(json.loads(line))
    threading.Thread(target=read, daemon=True).start()
    assert wait(lambda event: event["event"] == "ready")["version"] == "32.2.2"
    command(dict(action="candidates"))
    candidate_event = wait(lambda event: event["event"] == "candidates")
    candidate = next((item for item in candidate_event["windows"] if item["id"] == f"window:{identity['windowId']}:0"), None)
    assert candidate and candidate["pid"] == fixture.pid and candidate["executable"], candidate_event
    media = []
    for kind in ("screen", "app"):
        source_id = f"window:{identity['windowId']}:0" if kind == "app" else f"screen:{identity['displayId']}:0"
        start_index = len(events)
        command(dict(action="start", sourceKind=kind, sourceId=source_id, displayId=str(identity["displayId"]), sourceName="Synthetic Mac fixture", quality="custom",
                     customWidth=640, customHeight=360, customFPS=15, customCQ=28, clipSeconds=2, captureAudio=True,
                     microphone=False, allowSoftwareEncoder=True))
        recording = wait(lambda event: event in events[start_index:] and event["event"] == "recording")
        assert recording["encoder"] == "obs_x264" or "videotoolbox" in recording["encoder"], recording
        time.sleep(3)
        saves = []
        for number in range(2):
            file = folder / f"{kind}-{number}.mkv"
            request = str(uuid.uuid4())
            command(dict(action="save", path=str(file), requestId=request, requestedAt=int(time.time() * 1000)))
            saves.append((file, request))
            time.sleep(0.1)
        command(dict(action="stop"))
        for file, request in saves:
            saved = wait(lambda event: event.get("requestId") == request and event["event"] in ("saved", "error"), 40)
            assert saved["event"] == "saved", saved
            media.append(dict(kind=kind, encoder=recording["encoder"], **validate(file, identity["audioStarted"])))
            (folder / "partial-proof.json").write_text(json.dumps(dict(captures=media, fixtureAudioHealth=fixture_health), indent=2))
    helper.stdin.write(json.dumps(dict(action="exit")) + "\n")
    helper.stdin.flush()
    helper.wait(timeout=15)
    assert helper.returncode == 0, helper.returncode
    proof = dict(schema=1, platform=sys.platform, fixture=identity, captureTested=True, screenTested=True, windowTested=True,
                 generatedApplicationAudioTested=identity["audioStarted"], physicalMicrophoneTested=False,
                 permissionPromptsTested=False, captures=media)
    (folder / "proof.json").write_text(json.dumps(proof, indent=2))
    (root / ".cache/macos-capture/latest-proof.json").write_text(json.dumps(proof, indent=2))
    print(json.dumps(proof, indent=2))
finally:
    (folder / "fixture-health.json").write_text(json.dumps(locals().get("fixture_health", []), indent=2))
    (folder / "native-events.json").write_text(json.dumps(events, indent=2))
    for child in reversed(processes):
        if child.poll() is None:
            child.terminate()
            try:
                child.wait(timeout=5)
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait()
    for log in logs:
        log.close()
