"""Test an actual AppImage payload against private X11 and PulseAudio fixtures."""
import argparse
import hashlib
import json
import os
import pathlib
import shutil
import signal
import socket
import subprocess
import tempfile
import time
import uuid

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("appimage", type=pathlib.Path)
args = parser.parse_args()
artifact = args.appimage.resolve(strict=True)
if artifact.suffix != ".AppImage":
    raise ValueError("Pass the AppImage produced by electron-builder")
bun = shutil.which("bun")
if not bun:
    raise RuntimeError("Bun must be on PATH")
root = pathlib.Path.cwd()
evidence = root / ".cache/linux-packaged" / str(uuid.uuid4())
evidence.mkdir(parents=True)
private = pathlib.Path(tempfile.mkdtemp(prefix="attaclip-packaged-x11-"))
env = dict(os.environ, XDG_RUNTIME_DIR=str(private),
           PULSE_SERVER="unix:" + str(private / "audio.sock"),
           DBUS_SESSION_BUS_ADDRESS="unix:path=" + str(private / "dbus.sock"),
           WAYLAND_DISPLAY="", XDG_SESSION_TYPE="x11",
           ATTACLIP_NATIVE_TEST_SOFTWARE="1", ATTACLIP_PACKAGED_PRIVATE_X11="1",
           LIBGL_ALWAYS_SOFTWARE="1", GALLIUM_DRIVER="llvmpipe")
processes = []
logs = []


def launch(command, name):
    log = open(evidence / (name + ".log"), "w")
    logs.append(log)
    process = subprocess.Popen(command, env=env, stdout=log, stderr=log, start_new_session=True)
    processes.append(process)
    return process


def digest(file):
    with file.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


try:
    # Extraction executes the real AppImage runtime. No development Electron or
    # loose media/recorder overrides participate in the assertions below.
    artifact.chmod(artifact.stat().st_mode | 0o111)
    with open(evidence / "extract.log", "w") as log:
        subprocess.run([str(artifact), "--appimage-extract"], cwd=evidence,
                       stdout=log, stderr=log, check=True, timeout=90)
    package = evidence / "squashfs-root"
    executable = package / "attaclip"
    if not executable.is_file():
        raise RuntimeError("The AppImage does not contain the AttaClip executable")
    for binary in [package / "resources/recorder/attaclip-recorder",
                   package / "resources/media/ffmpeg", package / "resources/media/ffprobe"]:
        if not binary.is_file():
            raise RuntimeError(f"Missing packaged executable: {binary}")
    env["ATTACLIP_PACKAGED_EXE"] = str(executable)

    # Reserve an actual TCP display port. Existing desktop displays stay alone.
    display = None
    for number in range(90, 180):
        if pathlib.Path(f"/tmp/.X11-unix/X{number}").exists():
            continue
        with socket.socket() as candidate:
            try:
                candidate.bind(("127.0.0.1", 6000 + number))
                display = number
                break
            except OSError:
                continue
    if display is None:
        raise RuntimeError("No unused private X11 display is available")
    env["DISPLAY"] = f"127.0.0.1:{display}"
    launch(["Xvfb", f":{display}", "-screen", "0", "640x360x24",
            "-nolisten", "unix", "-listen", "tcp", "-ac"], "xvfb")
    deadline = time.monotonic() + 10
    while True:
        try:
            socket.create_connection(("127.0.0.1", 6000 + display), timeout=0.2).close()
            break
        except OSError:
            if time.monotonic() >= deadline:
                raise RuntimeError("Private X11 fixture did not start")
            time.sleep(0.1)
    launch(["pulseaudio", "-n", "--daemonize=no", "--exit-idle-time=-1",
            "--use-pid-file=no", "--disable-shm=true",
            "--load=module-native-protocol-unix socket=" + str(private / "audio.sock") + " auth-anonymous=1",
            "--load=module-null-sink sink_name=attaclip-test rate=48000 channels=2"], "pulse")
    deadline = time.monotonic() + 10
    while not (private / "audio.sock").exists():
        if time.monotonic() >= deadline:
            raise RuntimeError("Private audio fixture did not start")
        time.sleep(0.1)
    launch(["xclock", "-update", "1", "-geometry", "200x200+10+10"], "clock")
    tone = evidence / "tone.wav"
    subprocess.run([str(package / "resources/media/ffmpeg"), "-v", "error", "-f", "lavfi",
                    "-i", "sine=frequency=997:sample_rate=48000:duration=120",
                    "-ac", "2", str(tone)], check=True, timeout=20)
    launch(["paplay", "--device=attaclip-test", str(tone)], "tone")
    test = launch([bun, "tests/packaged.ts"], "application")
    result = test.wait(timeout=240)
    if result != 0:
        raise RuntimeError(f"Packaged application verification failed. Inspect {evidence}")
    report = dict(artifact=str(artifact), sha256=digest(artifact),
                  environment="Private X11 and PulseAudio, explicit software encoding",
                  result="passed", publicRedistributionVerified=False)
    (evidence / "report.json").write_text(json.dumps(report, indent=2) + "\n")
    print(f"Actual AppImage payload verification passed. Evidence: {evidence}")
finally:
    for process in reversed(processes):
        try:
            os.killpg(process.pid, signal.SIGTERM)
            if process.poll() is None:
                process.wait(timeout=8)
        except ProcessLookupError:
            pass
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
            process.wait(timeout=5)
    for log in logs:
        log.close()
    shutil.rmtree(private)
