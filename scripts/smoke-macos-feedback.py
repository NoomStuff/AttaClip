"""Actual Cocoa feedback over synthetic content, including fullscreen Spaces.

Only generated fixture media is opened. Proof images contain the helper's own
panel, not the desktop. Capture inclusion is measured, never assumed.
"""
import json
import os
from pathlib import Path
import plistlib
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
width, height = 640, 360
media_threads = ["-threads", "1", "-filter_threads", "1"]
motion_preferences = None


class MotionPreferences:
    """Change only a disposable hosted runner, and preserve key absence/type."""
    domain = "com.apple.universalaccess"
    key = "reduceMotion"

    def __init__(self):
        assert os.environ.get("GITHUB_ACTIONS") == "true", "Accessibility changes require GitHub Actions"
        assert os.environ.get("RUNNER_ENVIRONMENT") == "github-hosted", "Never change a self-hosted user's accessibility preferences"
        self.original = self.read()
        assert not self.original["present"] or type(self.original["value"]) is bool, "Unexpected Reduce Motion preference type"
        self.states = []
        self.restored = False
        self.record()

    def read(self):
        result = subprocess.run(["defaults", "export", self.domain, "-"], capture_output=True)
        assert result.returncode == 0, result.stderr.decode()
        domain = plistlib.loads(result.stdout)
        return dict(present=self.key in domain, value=domain.get(self.key))

    def record(self):
        (folder / "motion-preferences.json").write_text(json.dumps(dict(
            original=self.original, requestedStates=self.states, restored=self.restored), indent=2) + "\n")

    def set(self, reduced):
        subprocess.run(["defaults", "write", self.domain, self.key, "-bool", "true" if reduced else "false"], check=True)
        assert self.read() == dict(present=True, value=reduced), "The runner's actual preference did not change"
        self.states.append(reduced)
        self.record()

    def restore(self):
        if self.original["present"]:
            subprocess.run(["defaults", "write", self.domain, self.key, "-bool", "true" if self.original["value"] else "false"], check=True)
        else:
            subprocess.run(["defaults", "delete", self.domain, self.key], check=True)
        assert self.read() == self.original, "The original accessibility preference was not restored exactly"
        self.restored = True
        self.record()


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
                 sourceName="Synthetic feedback fixture", quality="custom", customWidth=width,
                 customHeight=height, customFPS=15, customCQ=23, clipSeconds=2,
                 captureAudio=False, microphone=False, allowSoftwareEncoder=True))
    return wait("recorder", lambda event: event in events["recorder"][index:] and event["event"] == "recording")


def motion_evidence(request, identity, reduced, leaving=False):
    samples = [event for event in events["notifier"] if event.get("id") == request and event["event"] == "animation"
               and (event["elapsed"] >= 2.4 if leaving else event["elapsed"] <= 0.25)]
    assert len(samples) >= 3, samples
    assert all(not event["active"] and not event["key"] and not event["main"] and
               event["foregroundPID"] == identity["pid"] and event["reducedMotion"] == reduced for event in samples), samples
    alpha_range = max(event["alpha"] for event in samples) - min(event["alpha"] for event in samples)
    y_range = max(event["y"] for event in samples) - min(event["y"] for event in samples)
    if reduced:
        assert y_range == 0, samples
        assert all(event["alpha"] == (0 if leaving else 1) for event in samples), samples
    else:
        assert alpha_range > 0.4 and y_range > 3, samples
    return dict(samples=len(samples), alphaRange=alpha_range, verticalTravel=y_range, reducedMotion=reduced)


def notice(identity, label, saving=True, expected_motion=None):
    request = str(uuid.uuid4())
    send(notifier, dict(message="Saving clip" if saving else "Clip saved", saving=saving,
                        id=request, trackAnimation=True, proofPath=str(folder / (label + "-panel.png"))))
    shown = wait("notifier", lambda event: event.get("id") == request and event["event"] == "shown")
    assert not shown["active"] and not shown["key"] and not shown["main"], shown
    assert shown["foregroundPID"] == identity["pid"], shown
    assert shown["visible"] and shown["alpha"] >= 0.99, shown
    if expected_motion is not None:
        assert shown["reducedMotion"] == expected_motion, "NSWorkspace did not observe the actual runner accessibility preference"
    shown["entryMotion"] = motion_evidence(request, identity, shown["reducedMotion"])
    return request, shown


def save(label, stop=True):
    output = folder / (label + ".mkv")
    request = str(uuid.uuid4())
    command(dict(action="save", path=str(output), requestId=request, requestedAt=int(time.time() * 1000)))
    result = wait("recorder", lambda event: event.get("requestId") == request and event["event"] in ("saved", "error"), 40)
    assert result["event"] == "saved", result
    if stop:
        command(dict(action="stop"))
    subprocess.run([ffmpeg, "-v", "error", *media_threads, "-i", str(output), "-map", "0", "-f", "null", "-"], check=True)
    return output


def pixels(output, x, y):
    raw = subprocess.run([ffmpeg, "-v", "error", *media_threads, "-i", str(output), "-vf", f"crop=2:2:{x}:{y},scale=1:1",
                          "-fps_mode", "passthrough", "-pix_fmt", "rgb24", "-threads", "1", "-f", "rawvideo", "-"],
                         check=True, capture_output=True).stdout
    assert len(raw) >= 30 and len(raw) % 3 == 0, "No complete feedback capture frames"
    return [list(raw[index:index + 3]) for index in range(0, len(raw), 3)]


def capture_evidence(output, identity, shown):
    screen = identity["screenFrame"]
    # OBS fits the whole source into a fixed output. Map a blank patch inside the
    # actual Cocoa panel to video pixels, away from the icon, text and corners.
    scale = min(width / screen["width"], height / screen["height"])
    offset_x = (width - screen["width"] * scale) / 2
    offset_y = (height - screen["height"] * scale) / 2
    x = int(offset_x + (shown["x"] + 180 - screen["x"]) * scale)
    y = int(offset_y + (screen["y"] + screen["height"] - shown["y"] - 14) * scale)
    sampled = pixels(output, x, y)
    dark = sum(all(abs(pixel[index] - value) <= 18 for index, value in enumerate((25, 23, 31))) for pixel in sampled)
    middle = pixels(output, width // 2, height // 2)
    colors = ((228, 76, 102), (65, 184, 170))
    classes = [next((index for index, color in enumerate(colors) if all(abs(pixel[channel] - color[channel]) <= 22 for channel in range(3))), None) for pixel in middle]
    assert None not in classes and set(classes) == {0, 1}, "Capture did not contain the actual changing selected fixture"
    return dict(path=str(output.relative_to(root)), panelPoint=dict(x=x, y=y),
                panelPixels=sampled, darkPanelFrames=dark, fixtureColorClasses=classes)


try:
    if "--ci-motion-matrix" in sys.argv:
        motion_preferences = MotionPreferences()
        motion_preferences.set(False)
    expected_motion = False if motion_preferences else None
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
        request, shown = notice(identity, kind, expected_motion=expected_motion)
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
    request, shown = notice(identity, "saved", False, expected_motion)
    hidden = wait("notifier", lambda event: event.get("id") == request and event["event"] == "hidden", 6)
    assert not hidden["visible"] and not hidden["timerActive"], hidden
    saved_exit = motion_evidence(request, identity, shown["reducedMotion"], leaving=True)
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
    request, shown = notice(space_identity, "fullscreen", expected_motion=expected_motion)
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
    reduced_proof = None
    if motion_preferences:
        motion_preferences.set(True)
        # A fresh native process reads the real OS preference. No helper-only
        # override can turn this into simulated accessibility behavior.
        notifier = launch([str(runtime / "attaclip-notifier")], "notifier", True)
        ready = wait("notifier", lambda event: event["event"] == "ready" and event["pid"] == notifier.pid)
        assert ready["bundleIdentifier"] == notifier_identity["bundleIdentifier"], ready
        request, shown = notice(space_identity, "reduced-motion", False, True)
        hidden = wait("notifier", lambda event: event.get("id") == request and event["event"] == "hidden", 6)
        assert not hidden["visible"] and not hidden["timerActive"], hidden
        reduced_proof = dict(notice=shown, exitMotion=motion_evidence(request, space_identity, True, leaving=True))
        send(notifier, dict(action="exit"))
        notifier.wait(timeout=10)
        assert notifier.returncode == 0, notifier.returncode
    proof = dict(schema=1, platform=sys.platform, notifier=notifier_identity,
                 nonactivatingPanelTested=True,
                 actualMotionTested=any(not item["notice"]["reducedMotion"] for item in captures),
                 reducedMotionStates=[item["notice"]["reducedMotion"] for item in captures], idleTimerStoppedTested=True,
                 fullscreenSpaceTested=True, exclusiveFullscreenTested=False,
                 selectedWindowExcludesPanel=True, displayCaptureIncludesPanel=True, captures=captures)
    proof["savedExitMotion"] = saved_exit
    proof["reducedMotionProof"] = reduced_proof
finally:
    try:
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
    finally:
        if motion_preferences:
            motion_preferences.restore()

proof["motionPreferenceRestored"] = motion_preferences.restored if motion_preferences else None
(folder / "proof.json").write_text(json.dumps(proof, indent=2) + "\n")
print(json.dumps(proof, indent=2))
