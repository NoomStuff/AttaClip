"""Actual ScreenCaptureKit audio isolation proof with two independent fixture apps."""
import array
import json
import math
import os
import pathlib
import plistlib
import shutil
import subprocess
import sys
import threading
import time
import uuid

assert sys.platform == "darwin", "This proof requires an actual macOS host"
root = pathlib.Path.cwd()
runtime = (root / "resources/recorder").resolve()
folder = root / ".cache/macos-audio" / str(uuid.uuid4())
folder.mkdir(parents=True)
env = dict(os.environ, DYLD_LIBRARY_PATH=str(runtime / "Frameworks"), DYLD_FRAMEWORK_PATH=str(runtime / "Frameworks"))
ffmpeg = str(root / "resources/media/ffmpeg")
ffprobe = str(root / "resources/media/ffprobe")
processes, logs, events, fixtures, media = [], [], [], [], []


def launch(args, name, pipe=False):
    log = (folder / (name + ".log")).open("w")
    logs.append(log)
    child = subprocess.Popen(args, cwd=root, env=env, stdin=subprocess.PIPE if pipe else subprocess.DEVNULL,
                             stdout=subprocess.PIPE if pipe else log, stderr=log, text=True)
    processes.append(child)
    return child


def fixture(name, frequency, compact=False):
    contents = folder / (name + ".app") / "Contents"
    (contents / "MacOS").mkdir(parents=True)
    with (root / "native/macos/fixture-Info.plist").open("rb") as source:
        info = plistlib.load(source)
    info["CFBundleIdentifier"] = "dev.attaclip.audio-proof." + name.lower()
    info["CFBundleName"] = name
    with (contents / "Info.plist").open("wb") as target:
        plistlib.dump(info, target)
    binary = contents / "MacOS/fixture"
    if fixtures:
        shutil.copy2(fixtures[0]["binary"], binary)
    else:
        subprocess.run(["swiftc", str(root / "native/macos/fixture.swift"), "-o", str(binary)], check=True)
    output = folder / (name + ".jsonl")
    fixtures.append(dict(output=output, binary=binary))
    launch(["open", "-n", "-W", str(contents.parent), "--args", str(output), str(frequency), "compact" if compact else "full"], name)
    deadline = time.monotonic() + 20
    while time.monotonic() < deadline:
        if output.exists() and "\n" in output.read_text():
            identity = json.loads(output.read_text().splitlines()[0])
            assert identity["audioStarted"], identity
            assert identity["bundleIdentifier"] == info["CFBundleIdentifier"], identity
            return identity
        time.sleep(0.05)
    raise RuntimeError("Fixture did not start: " + name)


def wait(predicate, timeout=30, after=0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        for event in events[after:]:
            if predicate(event):
                return event
        if helper.poll() is not None:
            raise RuntimeError(f"Recorder exited {helper.returncode}. Inspect {folder}")
        time.sleep(0.02)
    raise RuntimeError(f"Timed out. Events: {events[after:]}")


def command(data, expected="response"):
    identity = str(uuid.uuid4())
    helper.stdin.write(json.dumps(dict(data, id=identity)) + "\n")
    helper.stdin.flush()
    result = wait(lambda event: event.get("id") == identity)
    assert result["event"] == expected, result
    return result


def amplitudes(file, track):
    raw = subprocess.run([ffmpeg, "-v", "error", "-i", str(file), "-map", f"0:a:{track}", "-ac", "1", "-ar", "48000", "-t", "1", "-f", "f32le", "-"], capture_output=True, check=True).stdout
    samples = array.array("f")
    samples.frombytes(raw)
    assert len(samples) >= 24000, "Insufficient decoded audio"
    result = {}
    for frequency in (997, 1613):
        sine = sum(value * math.sin(2 * math.pi * frequency * index / 48000) for index, value in enumerate(samples))
        cosine = sum(value * math.cos(2 * math.pi * frequency * index / 48000) for index, value in enumerate(samples))
        result[str(frequency)] = 2 * math.hypot(sine, cosine) / len(samples)
    return result


def save(name, verify_frames=True):
    file = folder / (name + ".mkv")
    request = str(uuid.uuid4())
    command(dict(action="save", path=str(file), requestId=request, requestedAt=int(time.time() * 1000)))
    result = wait(lambda event: event.get("requestId") == request and event["event"] in ("saved", "error"), 45)
    assert result["event"] == "saved", result
    info = json.loads(subprocess.run([ffprobe, "-v", "error", "-show_streams", "-show_format", "-of", "json", str(file)], capture_output=True, text=True, check=True).stdout)
    tracks = [stream for stream in info["streams"] if stream["codec_type"] == "audio"]
    assert len(tracks) == 4, tracks
    assert [stream.get("tags", {}).get("title") for stream in tracks] == ["Master", "Capture audio", "Selected app", "System audio"], tracks
    assert float(info["format"]["duration"]) >= 1.5, info
    subprocess.run([ffmpeg, "-v", "error", "-i", str(file), "-map", "0", "-f", "null", "-"], check=True)
    video = next(stream for stream in info["streams"] if stream["codec_type"] == "video")
    assert (video["width"], video["height"]) == (640, 360), video
    pixels = subprocess.run([ffmpeg, "-v", "error", "-i", str(file), "-vf", "crop=2:2:iw/2:ih/2,scale=1:1", "-fps_mode", "passthrough", "-pix_fmt", "rgb24", "-f", "rawvideo", "-"], capture_output=True, check=True).stdout
    colors = ((228, 76, 102), (65, 184, 170))
    classes = [next((color for color, values in enumerate(colors) if all(abs(pixels[offset + index] - values[index]) <= 22 for index in range(3))), None) for offset in range(0, len(pixels), 3)]
    assert classes, "The saved video contained no decoded frames"
    if verify_frames:
        assert None not in classes and set(classes) == {0, 1}, "The saved video did not contain both changing fixture colors"
    result = dict(name=name, tracks=[amplitudes(file, index) for index in range(4)])
    media.append(result)
    (folder / "partial-proof.json").write_text(json.dumps(dict(captures=media), indent=2))
    return result["tracks"]


def only_main(track):
    assert track["997"] > 0.03, track
    assert track["1613"] < track["997"] / 8, track


try:
    selected = fixture("Selected", 997)
    decoy = fixture("Decoy", 1613, True)
    helper = launch([str(runtime / "attaclip-recorder"), str(runtime)], "native", True)
    def read():
        for line in helper.stdout:
            events.append(json.loads(line))
    threading.Thread(target=read, daemon=True).start()
    assert wait(lambda event: event["event"] == "ready")["version"] == "32.2.2"
    begin = len(events)
    command(dict(action="audio-devices", kind="output"))
    assert wait(lambda event: event["event"] == "audio-devices", after=begin)["devices"] == [dict(id="system", name="System audio")]
    application = dict(id="selected", name="Selected app", kind="application", sourceId=f"window:{selected['windowId']}:0", pid=selected["pid"], enabled=True, volume=1, muted=False, includeInMaster=False)
    system = dict(id="system", name="System audio", kind="output", deviceId="system", enabled=True, volume=1, muted=False, includeInMaster=False)
    configuration = dict(action="start", sourceKind="app", sourceId=f"window:{selected['windowId']}:0", sourceName="Selected fixture", quality="custom", customWidth=640, customHeight=360, customFPS=15, customCQ=28, clipSeconds=2, microphone=False, captureAudio=True, allowSoftwareEncoder=True, audioSources=[application, system])
    rejected = command(dict(configuration, audioSources=[dict(system, deviceId="unavailable-physical-output")]), "error")
    assert "System audio" in rejected["message"], rejected
    command(dict(action="stop"))
    command(configuration)
    time.sleep(3.5)
    baseline = save("isolated")
    for track in baseline[:3]:
        only_main(track)
    assert min(baseline[3].values()) > 0.03, baseline[3]
    assert 0.8 < baseline[0]["997"] / baseline[1]["997"] < 1.2, "Excluded extras changed master audio"
    command(dict(action="audio", source="selected", volume=0.5, muted=False))
    time.sleep(3)
    quieter = save("half-volume")
    assert 0.35 < quieter[2]["997"] / baseline[2]["997"] < 0.65, quieter[2]
    assert 0.8 < quieter[0]["997"] / baseline[0]["997"] < 1.2, quieter[0]
    command(dict(action="audio", source="selected", volume=0.5, muted=True))
    time.sleep(3)
    muted = save("muted")
    assert max(muted[2].values()) < 0.005, muted[2]
    only_main(muted[0])
    assert min(muted[3].values()) > 0.03, muted[3]
    command(dict(action="stop"))
    command(dict(configuration, captureAudio=False, audioSources=[dict(application, includeInMaster=True), system]))
    time.sleep(3)
    mixed = save("included-in-master")
    only_main(mixed[0])
    assert max(mixed[1].values()) < 0.005, mixed[1]
    assert 0.8 < mixed[0]["997"] / mixed[2]["997"] < 1.2, "Included app did not supply the master mix"
    # Video remains available in the other app. Losing the selected AUDIO app
    # must still report a stopped source rather than quietly capture its replacement.
    command(dict(action="source", sourceKind="app", sourceId=f"window:{decoy['windowId']}:0", sourceName="Decoy fixture", captureAudio=True))
    (fixtures[0]["output"].with_name(fixtures[0]["output"].name + ".stop")).touch()
    deadline = time.monotonic() + 15
    status = None
    while time.monotonic() < deadline:
        begin = len(events)
        command(dict(action="status"))
        status = wait(lambda event: event["event"] == "status", after=begin)
        if "Selected app" in status["message"] and status["waiting"]:
            break
        time.sleep(0.15)
    assert status and status["waiting"] and "Selected app" in status["message"], status
    save("preserved-after-audio-target-loss", verify_frames=False)
    command(dict(action="stop"))
    helper.stdin.write(json.dumps(dict(action="exit")) + "\n")
    helper.stdin.flush()
    helper.wait(timeout=15)
    assert helper.returncode == 0, helper.returncode
    proof = dict(schema=1, actualMacOS=True, selected=selected, decoy=decoy, appIsolationTested=True, systemMixTested=True, masterExclusionTested=True, liveGainTested=True, liveMuteTested=True, masterInclusionTested=True, audioTargetLossTested=True, previousFootageSavedAfterTargetLoss=True, physicalOutputFallbackRejected=True, physicalMicrophoneTested=False, captures=media, targetLoss=status)
    (folder / "proof.json").write_text(json.dumps(proof, indent=2))
    print(json.dumps(proof, indent=2))
finally:
    for item in fixtures:
        pathlib.Path(str(item["output"]) + ".stop").touch()
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
