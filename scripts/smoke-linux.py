"""Real capture test on a private X11 display and private PulseAudio sink."""
import json
import os
import pathlib
import queue
import subprocess
import sys
import tempfile
import time
import uuid
import socket

root = pathlib.Path.cwd()
runtime = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else "resources/recorder").resolve()
folder = root / ".cache/linux-smoke" / str(uuid.uuid4())
folder.mkdir(parents=True)
private = pathlib.Path(tempfile.mkdtemp(prefix="attaclip-native-"))
env = dict(os.environ, XDG_RUNTIME_DIR=str(private), PULSE_SERVER="unix:" + str(private / "audio.sock"), DBUS_SESSION_BUS_ADDRESS="unix:path=" + str(private / "dbus.sock"), WAYLAND_DISPLAY="", XDG_SESSION_TYPE="x11", ATTACLIP_NATIVE_TEST_SOFTWARE="1", LIBGL_ALWAYS_SOFTWARE="1", GALLIUM_DRIVER="llvmpipe")
env["LD_LIBRARY_PATH"] = str(runtime / "lib")
display = next(number for number in range(90, 180) if not pathlib.Path(f"/tmp/.X11-unix/X{number}").exists())
env["DISPLAY"] = f"127.0.0.1:{display}"
processes = []
logs = []
events = []

def launch(args, name, pipe=False):
    log = open(folder / (name + ".log"), "w")
    logs.append(log)
    process = subprocess.Popen(args, cwd=runtime, env=env, stdin=subprocess.PIPE if pipe else subprocess.DEVNULL, stdout=subprocess.PIPE if pipe else log, stderr=log, text=True)
    processes.append(process)
    return process

def wait(predicate, timeout=20):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        for event in events:
            if predicate(event):
                return event
        if helper.poll() is not None:
            raise RuntimeError(f"Recorder exited {helper.returncode}. Inspect {folder}")
        time.sleep(0.02)
    raise RuntimeError(f"Native command timed out: {events}")

def command(data, expected="response"):
    identity = str(uuid.uuid4())
    helper.stdin.write(json.dumps(dict(data, id=identity)) + "\n")
    helper.stdin.flush()
    result = wait(lambda event: event.get("id") == identity)
    assert result["event"] == expected, result
    return result

def volume(file, track):
    result = subprocess.run(["ffmpeg", "-hide_banner", "-i", str(file), "-map", f"0:a:{track}", "-af", "volumedetect", "-f", "null", "-"], capture_output=True, text=True)
    assert result.returncode == 0, result.stderr
    import re
    return float(re.search(r"mean_volume: (-?[\d.]+) dB", result.stderr)[1])

try:
    launch(["Xvfb", f":{display}", "-screen", "0", "640x360x24", "-nolisten", "unix", "-listen", "tcp", "-ac"], "xvfb")
    deadline = time.monotonic() + 10
    while True:
        try:
            socket.create_connection(("127.0.0.1", 6000+display), timeout=0.2).close()
            break
        except OSError:
            assert time.monotonic() < deadline, "Private Xvfb did not start"
            time.sleep(0.1)
    launch(["pulseaudio", "-n", "--daemonize=no", "--exit-idle-time=-1", "--use-pid-file=no", "--disable-shm=true", "--load=module-native-protocol-unix socket=" + str(private / "audio.sock") + " auth-anonymous=1", "--load=module-null-sink sink_name=attaclip-test rate=48000 channels=2"], "pulse")
    deadline = time.monotonic() + 10
    while not (private / "audio.sock").exists():
        assert time.monotonic() < deadline, "Private PulseAudio did not start"
        time.sleep(0.1)
    launch(["xclock", "-update", "1", "-geometry", "200x200+10+10"], "clock")
    tone = folder / "tone.wav"
    subprocess.run(["ffmpeg", "-v", "error", "-f", "lavfi", "-i", "sine=frequency=997:sample_rate=48000:duration=90", "-ac", "2", str(tone)], check=True)
    launch(["paplay", "--device=attaclip-test", str(tone)], "tone")
    helper = launch([str(runtime / "attaclip-recorder"), str(runtime)], "native", True)
    import threading
    def read():
        for line in helper.stdout:
            events.append(json.loads(line))
    threading.Thread(target=read, daemon=True).start()
    ready = wait(lambda event: event["event"] == "ready")
    assert ready["version"] == "32.2.0", ready
    denied = command(dict(action="start",sourceKind="screen",screenIndex=0,quality="low",clipSeconds=2,captureAudio=False,microphone=False,allowSoftwareEncoder=False), "error")
    assert "software" in denied["message"].lower(), denied
    command(dict(action="stop"))
    command(dict(action="start", sourceKind="screen", sourceName="Private X11", screenIndex=0, bounds=dict(x=0,y=0,width=640,height=360), quality="custom",customWidth=640,customHeight=360,customFPS=24,customCQ=28,clipSeconds=2,captureAudio=True,microphone=False,allowSoftwareEncoder=True,captureVolume=0.5))
    recording = wait(lambda event: event["event"] == "recording")
    assert recording["encoder"] == "obs_x264", recording
    measured = {}
    for name, gain, mute in [("half",0.5,False),("full",1,False),("muted",1,True)]:
        command(dict(action="audio",source="capture",volume=gain,muted=mute))
        time.sleep(4)
        file = folder / (name + ".mkv")
        command(dict(action="save",path=str(file),requestId=name,requestedAt=int(time.time()*1000)))
        wait(lambda event: event["event"] == "saved" and event["requestId"] == name)
        probe = json.loads(subprocess.check_output(["ffprobe","-v","error","-show_streams","-show_format","-of","json",str(file)], text=True))
        video = probe["streams"][0]
        assert (video["codec_name"],video["width"],video["height"],video["r_frame_rate"]) == ("h264",640,360,"24/1"), video
        assert 1.5 < float(probe["format"]["duration"]) < 3.2, probe
        assert [stream["tags"]["title"] for stream in probe["streams"][1:]] == ["Master","Capture audio"]
        subprocess.run(["ffmpeg","-v","error","-i",str(file),"-f","null","-"],check=True)
        # The private X11 fixture must appear in actual encoded pixels.
        frame = subprocess.check_output(["ffmpeg","-v","error","-ss","0.4","-i",str(file),"-frames:v","1","-pix_fmt","gray","-f","rawvideo","-"])
        assert len(frame) == 640*360 and sum(frame)/len(frame)>10, "The encoded private X11 screen is black"
        measured[name] = [volume(file,0),volume(file,1)]
    for track in range(2):
        assert measured["full"][track] > -55, measured
        assert abs(measured["full"][track]-measured["half"][track]-6.02)<1, measured
        assert measured["muted"][track]<-70, measured
    assert any(event["event"]=="audio-levels" and event.get("capture",0)>0.05 for event in events)
    # Accepted save requests must survive immediate Stop on the software path.
    command(dict(action="save",path=str(folder/"queued.mkv"),requestId="queued",requestedAt=int(time.time()*1000)))
    command(dict(action="stop"))
    wait(lambda event: event["event"]=="saved" and event.get("requestId")=="queued")
    subprocess.run(["ffmpeg","-v","error","-i",str(folder/"queued.mkv"),"-f","null","-"],check=True)
    # A name collision must preserve the existing file rather than overwrite it.
    sentinel = folder / "existing.mkv"
    sentinel.write_bytes(b"existing user file")
    command(dict(action="start",sourceKind="screen",screenIndex=0,quality="custom",customWidth=640,customHeight=360,customFPS=24,customCQ=28,clipSeconds=2,captureAudio=False,microphone=False,allowSoftwareEncoder=True))
    time.sleep(3)
    command(dict(action="save",path=str(sentinel),requestId="collision",requestedAt=int(time.time()*1000)))
    wait(lambda event: event["event"]=="error" and event.get("requestId")=="collision")
    assert sentinel.read_bytes()==b"existing user file"
    command(dict(action="stop"))
    helper.stdin.write('{"action":"exit"}\n')
    helper.stdin.flush()
    assert helper.wait(timeout=10)==0
    (folder/"measurements.json").write_text(json.dumps(measured,indent=2))
    print("Real Linux X11/PulseAudio/x264 smoke passed", measured, folder)
finally:
    for process in reversed(processes):
        if process.poll() is None:
            process.terminate()
            try: process.wait(timeout=5)
            except subprocess.TimeoutExpired: process.kill()
    for log in logs: log.close()
    (folder/"events.json").write_text(json.dumps(events,indent=2))
    import shutil
    shutil.rmtree(private)
