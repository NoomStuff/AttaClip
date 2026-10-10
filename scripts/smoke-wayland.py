"""Actual monitor-only portal capture, pending permission, denial and stream loss."""
import hashlib
import json
import os
import pathlib
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import uuid

root = pathlib.Path.cwd().resolve()
runtime = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else "resources/recorder").resolve()
fixture = root / ".cache/wayland-portal-fixture"
assert fixture.is_file(), "Build scripts/build-wayland-fixture.py first"
folder = root / ".cache/linux-smoke" / str(uuid.uuid4())
folder.mkdir(parents=True)
private = pathlib.Path(tempfile.mkdtemp(prefix="attaclip-wayland-"))
private.chmod(0o700)
env = dict(os.environ, XDG_RUNTIME_DIR=str(private), XDG_CONFIG_HOME=str(private / "config"), XDG_DATA_HOME=str(private / "data"), XDG_CACHE_HOME=str(private / "cache"), XDG_CURRENT_DESKTOP="sway", XDG_SESSION_TYPE="wayland", WLR_BACKENDS="headless", WLR_LIBINPUT_NO_DEVICES="1", WLR_RENDERER="pixman", WLR_RENDERER_ALLOW_SOFTWARE="1", LIBGL_ALWAYS_SOFTWARE="1", GALLIUM_DRIVER="llvmpipe", ATTACLIP_NATIVE_TEST_SOFTWARE="1", ATTACLIP_NATIVE_TEST_PORTAL="1", PULSE_SERVER="unix:" + str(private / "audio.sock"))
for key in ["DISPLAY", "WAYLAND_DISPLAY", "SWAYSOCK", "DBUS_SESSION_BUS_ADDRESS"]:
    env.pop(key, None)
env["LD_LIBRARY_PATH"] = str(runtime / "lib")
processes, logs, events = [], [], []
helper = None

def launch(args, name, pipe=False, stdout=False):
    log = open(folder / (name + ".log"), "w")
    logs.append(log)
    process = subprocess.Popen(args, env=env, cwd=root, stdin=subprocess.PIPE if pipe else subprocess.DEVNULL, stdout=subprocess.PIPE if pipe or stdout else log, stderr=log, text=True)
    processes.append(process)
    return process

def wait(predicate, timeout=20, start=0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        for event in events[start:]:
            if predicate(event):
                return event
        if helper is not None and helper.poll() is not None:
            raise RuntimeError(f"Recorder exited {helper.returncode}. Inspect {folder}")
        time.sleep(0.02)
    raise RuntimeError(f"Timed out. Inspect {folder}")

def command(data, expected="response"):
    identity = str(uuid.uuid4())
    helper.stdin.write(json.dumps(dict(data, id=identity)) + "\n")
    helper.stdin.flush()
    response = wait(lambda event: event.get("id") == identity)
    assert response["event"] == expected, response
    return response

def status():
    before = len(events)
    command(dict(action="status"))
    return wait(lambda event: event["event"] == "status", start=before)

def state(predicate, timeout=20):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        value = status()
        if predicate(value):
            return value
        time.sleep(0.1)
    raise AssertionError(value)

def decode(file):
    probe = json.loads(subprocess.check_output(["ffprobe", "-v", "error", "-show_streams", "-show_format", "-of", "json", str(file)], text=True))
    video = probe["streams"][0]
    assert (video["width"], video["height"], video["r_frame_rate"]) == (640, 360, "24/1"), video
    assert 1.5 < float(probe["format"]["duration"]) < 3.3, probe
    subprocess.run(["ffmpeg", "-v", "error", "-i", str(file), "-enc_time_base", "demux", "-f", "null", "-"], check=True)
    frames = subprocess.check_output(["ffmpeg", "-v", "error", "-i", str(file), "-map", "0:v:0", "-f", "framemd5", "-"], text=True)
    hashes = {line.rsplit(",", 1)[-1].strip() for line in frames.splitlines() if not line.startswith("#")}
    assert len(hashes) > 20, "The encoded screen did not contain the fixture's changing pixels"
    peaks = []
    for track in range(2):
        result = subprocess.run(["ffmpeg", "-hide_banner", "-i", str(file), "-map", f"0:a:{track}", "-af", "volumedetect", "-f", "null", "-"], capture_output=True, text=True, check=True)
        level = float(re.search(r"mean_volume: (-?[\d.]+) dB", result.stderr)[1])
        assert level > -40, "The private captured tone was not audible"
        peaks.append(level)
    return dict(distinctFrames=len(hashes), audioMeanDB=peaks, duration=float(probe["format"]["duration"]))

try:
    config = private / "sway.conf"
    config.write_text("output HEADLESS-1 mode 640x360@60Hz\noutput HEADLESS-1 bg #0022ff solid_color\nseat seat0 fallback true\n")
    sway = launch(["sway", "--unsupported-gpu", "-c", str(config)], "sway")
    deadline = time.monotonic() + 10
    while True:
        sockets = [file for file in private.glob("wayland-*") if not file.name.endswith(".lock")]
        if sockets:
            break
        assert sway.poll() is None and time.monotonic() < deadline, "Private Sway could not start"
        time.sleep(0.1)
    env["WAYLAND_DISPLAY"] = sockets[0].name
    env["SDL_VIDEODRIVER"] = "wayland"
    launch(["ffplay", "-v", "error", "-an", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=24", "-window_title", "AttaClip private Wayland motion"], "motion")
    dbus = launch(["dbus-daemon", "--session", "--nofork", "--print-address"], "dbus", stdout=True)
    env["DBUS_SESSION_BUS_ADDRESS"] = dbus.stdout.readline().strip()
    pipewire = launch(["pipewire"], "pipewire")
    launch(["wireplumber"], "wireplumber")
    launch(["pulseaudio", "-n", "--daemonize=no", "--exit-idle-time=-1", "--use-pid-file=no", "--disable-shm=true", "--load=module-native-protocol-unix socket=" + str(private / "audio.sock") + " auth-anonymous=1", "--load=module-null-sink sink_name=attaclip-test rate=48000 channels=2"], "pulse")
    deadline = time.monotonic() + 10
    while not (private / "audio.sock").exists():
        assert time.monotonic() < deadline
        time.sleep(0.1)
    tone = folder / "tone.wav"
    subprocess.run(["ffmpeg", "-v", "error", "-f", "lavfi", "-i", "sine=frequency=997:sample_rate=48000:duration=180", "-ac", "2", str(tone)], check=True)
    launch(["paplay", "--device=attaclip-test", str(tone)], "tone")
    chooser = private / "choose.sh"
    chooser.write_text("#!/bin/sh\nsleep 4\nif test -f '" + str(private / "deny") + "'; then exit 1; fi\nprintf 'HEADLESS-1\\n'\n")
    chooser.chmod(0o700)
    portalconfig = private / "portal.conf"
    portalconfig.write_text("[screencast]\nchooser_type=simple\nchooser_cmd=" + str(chooser) + "\nmax_fps=24\n")
    backend = launch([str(fixture), "-l", "DEBUG", "-c", str(portalconfig)], "portal-wlr")
    deadline = time.monotonic() + 10
    while True:
        owned = subprocess.run(["gdbus", "call", "--session", "--dest", "org.freedesktop.DBus", "--object-path", "/org/freedesktop/DBus", "--method", "org.freedesktop.DBus.NameHasOwner", "org.freedesktop.impl.portal.desktop.wlr"], env=env, capture_output=True, text=True)
        if "true" in owned.stdout:
            break
        assert backend.poll() is None and time.monotonic() < deadline
        time.sleep(0.1)
    launch(["/usr/libexec/xdg-desktop-portal", "--verbose"], "portal")
    time.sleep(2)
    helper = launch([str(runtime / "attaclip-recorder"), str(runtime)], "native", pipe=True)
    def read():
        for line in helper.stdout:
            events.append(json.loads(line))
    threading.Thread(target=read, daemon=True).start()
    ready = wait(lambda event: event["event"] == "ready")
    assert ready["captureBackend"] == "wayland-portal" and ready["sourceKinds"] == ["screen"] and ready["portalPicker"] is True, ready
    settings = dict(sourceKind="screen", sourceId="portal:screen", sourceName="Portal-selected screen", quality="custom", customWidth=640, customHeight=360, customFPS=24, customCQ=28, clipSeconds=2, captureAudio=True, microphone=False, allowSoftwareEncoder=True)
    for kind, identity in [("app", "window:1:0"), ("auto", "portal:screen"), ("screen", "screen:0:0")]:
        rejected = command(dict(settings, action="start", sourceKind=kind, sourceId=identity), "error")
        assert "system screen picker" in rejected["message"].lower(), rejected
        command(dict(action="stop"))
    begin = time.monotonic()
    command(dict(settings, action="start"))
    ack = time.monotonic() - begin
    assert ack < 3, f"Start waited {ack:.3f}s for the screen picker"
    waiting = status()
    assert waiting["waiting"] and waiting["availableSeconds"] == 0 and "picker" in waiting["message"], waiting
    command(dict(action="save", path=str(folder / "before-grant.mkv"), requestId="before-grant"))
    wait(lambda event: event["event"] == "error" and event.get("requestId") == "before-grant")
    command(dict(action="stop"))
    assert not status()["active"]
    time.sleep(5)
    assert helper.poll() is None and not (folder / "before-grant.mkv").exists()
    (private / "deny").touch()
    command(dict(settings, action="start"))
    denial = state(lambda value: "declined" in value["message"])
    assert denial["waiting"] and denial["availableSeconds"] == 0, denial
    command(dict(action="stop"))
    (private / "deny").unlink()
    command(dict(settings, action="start"))
    state(lambda value: not value["waiting"] and value["availableSeconds"] >= 1.8)
    first = folder / "actual.mkv"
    command(dict(action="save", path=str(first), requestId="actual", requestedAt=int(time.time() * 1000)))
    saved = wait(lambda event: event["event"] == "saved" and event.get("requestId") == "actual")
    actual = decode(first)
    assert saved["source"] == "Portal-selected screen", saved
    queued = folder / "queued-switch.mkv"
    command(dict(action="save", path=str(queued), requestId="queued-switch", requestedAt=int(time.time() * 1000)))
    begin = time.monotonic()
    command(dict(settings, action="source"))
    source_ack = time.monotonic() - begin
    assert source_ack < 3, f"Source waited {source_ack:.3f}s for the screen picker"
    assert status()["waiting"]
    wait(lambda event: event["event"] == "saved" and event.get("requestId") == "queued-switch")
    queued_media = decode(queued)
    state(lambda value: not value["waiting"] and value["availableSeconds"] >= 1.8)
    command(dict(action="test-close-portal"))
    closed_state = state(lambda value: value["waiting"] and value["message"] == "Screen capture stopped")
    time.sleep(4)
    closed = folder / "after-session-close.mkv"
    command(dict(action="save", path=str(closed), requestId="after-close", requestedAt=int(time.time() * 1000)))
    prior_closed = wait(lambda event: event["event"] == "saved" and event.get("requestId") == "after-close")
    assert prior_closed.get("previousFootage"), prior_closed
    closed_media = decode(closed)
    command(dict(settings, action="source"))
    state(lambda value: not value["waiting"] and value["availableSeconds"] >= 1.8)
    pipewire.terminate()
    pipewire.wait(timeout=5)
    state(lambda value: value["waiting"])
    time.sleep(4)
    lost = folder / "after-loss.mkv"
    command(dict(action="save", path=str(lost), requestId="after-loss", requestedAt=int(time.time() * 1000)))
    command(dict(action="stop"))
    prior = wait(lambda event: event["event"] == "saved" and event.get("requestId") == "after-loss")
    assert prior.get("previousFootage"), prior
    loss = decode(lost)
    assert status()["availableSeconds"] == 0
    helper.stdin.write('{"action":"exit"}\n')
    helper.stdin.flush()
    assert helper.wait(timeout=10) == 0
    native_log = (folder / "native.log").read_text()
    assert "loop->recurse" not in native_log and "Assertion" not in native_log, native_log
    hashes = {name: hashlib.sha256((runtime / name).read_bytes()).hexdigest() for name in ["attaclip-recorder", "obs-plugins/linux-pipewire.so"]}
    (folder / "wayland-proof.json").write_text(json.dumps(dict(binaryHashes=hashes, startAckSeconds=ack, sourceAckSeconds=source_ack, actual=actual, queued=queued_media, closed=closed_media, loss=loss, checks=["screen-only", "explicit-portal-identity", "async-start-and-source", "stop-before-grant", "denial", "moving-pixels", "audible-master-and-capture", "queued-save-survives-source-switch", "last-valid-save-after-session-close", "last-valid-save-and-stop-after-PipeWire-loss", "clean-teardown"]), indent=2) + "\n")
    print("Actual Wayland portal proof passed", folder)
finally:
    for process in reversed(processes):
        if process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)
    for log in logs:
        log.close()
    (folder / "events.json").write_text(json.dumps(events, indent=2) + "\n")
    shutil.rmtree(private)
