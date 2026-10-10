"""Actual Cocoa feedback over synthetic content, including fullscreen Spaces.

Only generated fixture media is opened. Proof images contain the helper's own
panel, not the desktop. Capture inclusion is measured, never assumed.
"""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import threading
import time
import uuid

assert sys.platform == "darwin", "Native feedback proof needs a real Mac host"
root = Path.cwd()
runtime = root / "resources/recorder"
folder = root / ".cache/macos-feedback" / str(uuid.uuid4())
folder.mkdir(parents=True)
env = dict(os.environ, DYLD_LIBRARY_PATH=str(runtime / "Frameworks"), DYLD_FRAMEWORK_PATH=str(runtime / "Frameworks"))
events = {"recorder": [], "notifier": []}
children = []
logs = []
fixture_paths = []
ffmpeg = str(root / "resources/media/ffmpeg")


def launch(args, name, pipe=False):
    log = (folder / (name + ".log")).open("w")
    logs.append(log)
    process = subprocess.Popen(args, cwd=root, env=env, text=True,
                               stdin=subprocess.PIPE if pipe else subprocess.DEVNULL,
                               stdout=subprocess.PIPE if pipe else log, stderr=log)
    children.append(process)
    if pipe:
        def read():
            for line in process.stdout:
                events[name].append(json.loads(line))
        threading.Thread(target=read, daemon=True).start()
    return process


def wait(name, predicate, timeout=25):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        result = next((event for event in events[name] if predicate(event)), None)
        if result is not None:
            return result
        time.sleep(0.02)
    raise RuntimeError(f"{name} timed out: {events[name]}")


def send(process, value):
    process.stdin.write(json.dumps(value) + "\n")
    process.stdin.flush()


def command(value):
    identity = str(uuid.uuid4())
    send(recorder, dict(value, id=identity))
    result = wait("recorder", lambda event: event.get("id") == identity)
    assert result["event"] == "response", result
    return result


def fixture(name, mode=""):
    contents = folder / (name + ".app") / "Contents"
    (contents / "MacOS").mkdir(parents=True)
    info = (root / "native/macos/fixture-Info.plist").read_text()
    info = info.replace("dev.attaclip.capture-fixture", "dev.attaclip.feedback-proof." + name.lower())
    (contents / "Info.plist").write_text(info)
    shutil.copyfile(fixture_binary, contents / "MacOS/fixture")
    os.chmod(contents / "MacOS/fixture", 0o755)
    output = folder / (name + ".jsonl")
    fixture_paths.append(output)
    process = launch(["open", "-n", "-W", str(contents.parent), "--args", str(output), "997", mode], name)
    deadline = time.monotonic() + 20
    while not output.exists() or "\n" not in output.read_text():
        if time.monotonic() >= deadline:
            raise RuntimeError("Synthetic focus fixture did not start")
        time.sleep(0.05)
    identity = json.loads(output.read_text().splitlines()[0])
    return process, output, identity


def start_capture(identity, kind):
    index = len(events["recorder"])
    source = f"screen:{identity['displayId']}:0" if kind == "screen" else f"window:{identity['windowId']}:0"
    command(dict(action="start", sourceKind=kind, sourceId=source, displayId=str(identity["displayId"]),
                 sourceName="Synthetic feedback fixture", quality="custom", customWidth=1280,
                 customHeight=720, customFPS=15, customCQ=23, clipSeconds=2,
                 captureAudio=False, microphone=False, allowSoftwareEncoder=True))
    return wait("recorder", lambda event: event in events["recorder"][index:] and event["event"] == "recording")


def notice(identity, label, saving=True):
    request = str(uuid.uuid4())
    send(notifier, dict(message="Saving clip" if saving else "Clip saved", saving=saving,
                        id=request, trackAnimation=True, proofPath=str(folder / (label + "-panel.png"))))
    shown = wait("notifier", lambda event: event.get("id") == request and event["event"] == "shown")
    assert not shown["active"] and not shown["key"] and not shown["main"], shown
    assert shown["foregroundPID"] == identity["pid"], shown
    assert shown["visible"] and shown["alpha"] >= 0.99, shown
    samples = [event for event in events["notifier"] if event.get("id") == request and event["event"] == "animation"]
    if not shown["reducedMotion"]:
        assert len(samples) >= 3 and max(event["alpha"] for event in samples) - min(event["alpha"] for event in samples) > 0.4, samples
        assert max(event["y"] for event in samples) - min(event["y"] for event in samples) > 3, samples
    return request, shown


def save(label, stop=True):
    output = folder / (label + ".mkv")
    request = str(uuid.uuid4())
    command(dict(action="save", path=str(output), requestId=request, requestedAt=int(time.time() * 1000)))
    result = wait("recorder", lambda event: event.get("requestId") == request and event["event"] in ("saved", "error"), 40)
    assert result["event"] == "saved", result
    if stop:
        command(dict(action="stop"))
    subprocess.run([ffmpeg, "-v", "error", "-i", str(output), "-map", "0", "-f", "null", "-"], check=True)
    return output


def pixels(output, x, y):
    raw = subprocess.run([ffmpeg, "-v", "error", "-i", str(output), "-vf", f"crop=2:2:{x}:{y},scale=1:1",
                          "-fps_mode", "passthrough", "-pix_fmt", "rgb24", "-f", "rawvideo", "-"],
                         check=True, capture_output=True).stdout
    assert len(raw) >= 30 and len(raw) % 3 == 0, "No complete feedback capture frames"
    return [list(raw[index:index + 3]) for index in range(0, len(raw), 3)]


def capture_evidence(output, identity, shown):
    screen = identity["screenFrame"]
    # OBS fits the whole source into a fixed output. Map a blank patch inside the
    # actual Cocoa panel to video pixels, away from the icon, text and corners.
    scale = min(1280 / screen["width"], 720 / screen["height"])
    offset_x = (1280 - screen["width"] * scale) / 2
    offset_y = (720 - screen["height"] * scale) / 2
    x = int(offset_x + (shown["x"] + 180 - screen["x"]) * scale)
    y = int(offset_y + (screen["y"] + screen["height"] - shown["y"] - 14) * scale)
    sampled = pixels(output, x, y)
    dark = sum(all(abs(pixel[index] - value) <= 18 for index, value in enumerate((25, 23, 31))) for pixel in sampled)
    middle = pixels(output, 640, 360)
    colors = ((228, 76, 102), (65, 184, 170))
    classes = [next((index for index, color in enumerate(colors) if all(abs(pixel[channel] - color[channel]) <= 22 for channel in range(3))), None) for pixel in middle]
    assert None not in classes and set(classes) == {0, 1}, "Capture did not contain the actual changing selected fixture"
    return dict(path=str(output.relative_to(root)), panelPoint=dict(x=x, y=y),
                panelPixels=sampled, darkPanelFrames=dark, fixtureColorClasses=classes)


try:
    fixture_binary = folder / "fixture"
    subprocess.run(["swiftc", str(root / "native/macos/fixture.swift"), "-o", str(fixture_binary)], check=True)
    normal, normal_output, identity = fixture("Normal")
    notifier = launch([str(runtime / "attaclip-notifier")], "notifier", True)
    notifier_identity = wait("notifier", lambda event: event["event"] == "ready")
    assert notifier_identity["bundleIdentifier"] == "dev.attaclip.notifier", notifier_identity
    recorder = launch([str(runtime / "attaclip-recorder"), str(runtime)], "recorder", True)
    wait("recorder", lambda event: event["event"] == "ready")
    captures = []
    for kind in ("screen", "app"):
        start_capture(identity, kind)
        # A dark sample is only evidence of the popup if the same location was
        # actually covered by our colorful fixture before the popup appeared.
        # Hide the preceding request before taking the next baseline.
        if kind == "app":
            send(notifier, dict(message="Clip saved", saving=False, id="before-app"))
            wait("notifier", lambda event: event.get("id") == "before-app" and event["event"] == "hidden", 6)
        time.sleep(2.5)
        baseline = save(kind + "-baseline", False)
        request, shown = notice(identity, kind)
        time.sleep(2.5)
        output = save(kind)
        evidence = capture_evidence(output, identity, shown)
        before = capture_evidence(baseline, identity, shown)
        assert before["darkPanelFrames"] == 0, "The measured area was already dark before feedback appeared"
        colors = ((228, 76, 102), (65, 184, 170))
        assert all(any(all(abs(pixel[channel] - color[channel]) <= 22 for channel in range(3)) for color in colors)
                   for pixel in before["panelPixels"]), "The popup location was not covered by the actual selected fixture"
        if kind == "screen":
            # Current official OBS display capture excludes no arbitrary helper.
            # Prove visibility and record the limitation rather than claim privacy.
            assert evidence["darkPanelFrames"] > 10, evidence
        else:
            assert evidence["darkPanelFrames"] == 0, "A separate popup appeared inside selected-window capture"
        captures.append(dict(kind=kind, notice=shown, baseline=before, **evidence))
    request, shown = notice(identity, "saved", False)
    hidden = wait("notifier", lambda event: event.get("id") == request and event["event"] == "hidden", 6)
    assert not hidden["visible"] and not hidden["timerActive"], hidden
    Path(str(normal_output) + ".stop").touch()
    normal.wait(timeout=10)

    space, space_output, space_identity = fixture("Fullscreen", "fullscreen")
    deadline = time.monotonic() + 20
    fullscreen = None
    while time.monotonic() < deadline:
        health = [json.loads(line) for line in space_output.read_text().splitlines()[1:]]
        fullscreen = next((item for item in reversed(health) if item.get("fullscreenSpace") and item.get("foreground")), None)
        if fullscreen:
            break
        time.sleep(0.1)
    assert fullscreen, "The fixture did not enter an actual native fullscreen Space"
    start_capture(space_identity, "screen")
    time.sleep(2.5)
    baseline = save("fullscreen-space-baseline", False)
    request, shown = notice(space_identity, "fullscreen")
    time.sleep(2.5)
    output = save("fullscreen-space")
    space_evidence = capture_evidence(output, space_identity, shown)
    before = capture_evidence(baseline, space_identity, shown)
    assert before["darkPanelFrames"] == 0, "The fullscreen popup location was already dark"
    colors = ((228, 76, 102), (65, 184, 170))
    assert all(any(all(abs(pixel[channel] - color[channel]) <= 22 for channel in range(3)) for color in colors)
               for pixel in before["panelPixels"]), "The actual fullscreen fixture did not cover the popup location"
    assert space_evidence["darkPanelFrames"] > 10, "The panel did not appear in the actual fullscreen Space capture"
    captures.append(dict(kind="fullscreen-space", notice=shown, fixtureHealth=fullscreen, baseline=before, **space_evidence))
    send(recorder, dict(action="exit"))
    recorder.wait(timeout=15)
    assert recorder.returncode == 0, recorder.returncode
    send(notifier, dict(action="exit"))
    notifier.wait(timeout=10)
    assert notifier.returncode == 0, notifier.returncode
    proof = dict(schema=1, platform=sys.platform, notifier=notifier_identity,
                 nonactivatingPanelTested=True,
                 actualMotionTested=any(not item["notice"]["reducedMotion"] for item in captures),
                 reducedMotionStates=[item["notice"]["reducedMotion"] for item in captures], idleTimerStoppedTested=True,
                 fullscreenSpaceTested=True, exclusiveFullscreenTested=False,
                 selectedWindowExcludesPanel=True, displayCaptureIncludesPanel=True, captures=captures)
    (folder / "proof.json").write_text(json.dumps(proof, indent=2) + "\n")
    print(json.dumps(proof, indent=2))
finally:
    for output in fixture_paths:
        Path(str(output) + ".stop").touch()
    for name, values in events.items():
        (folder / (name + "-events.json")).write_text(json.dumps(values, indent=2) + "\n")
    for child in reversed(children):
        if child.poll() is None:
            child.terminate()
            try:
                child.wait(timeout=5)
            except subprocess.TimeoutExpired:
                child.kill()
    for log in logs:
        log.close()
