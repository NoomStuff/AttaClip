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
display = next(number for number in range(90, 180) if not pathlib.Path(f"/tmp/.X11-unix/X{number}").exists() and not pathlib.Path(f"/tmp/.X{number}-lock").exists())
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

try:
    xvfb=launch(["Xvfb", f":{display}", "-screen", "0", "640x360x24", "-nolisten", "unix", "-listen", "tcp", "-ac"], "xvfb")
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
    if os.environ.get("ATTACLIP_TEST_X11_APP"):
        launch(["openbox", "--sm-disable"], "window-manager")
        time.sleep(1)
    env["WINEPREFIX"]=str(folder/"wine-prefix")
    env["WINEARCH"]="win64";env["WINEDEBUG"]="-all";env["WINEDLLOVERRIDES"]="winemenubuilder.exe=d"
    launch(["openbox","--sm-disable"],"window-manager")
    import shutil
    image=folder/"My Game/AttaClipWineGame.exe"
    image.parent.mkdir(parents=True)
    shutil.copyfile(root/".cache/native-tests-linux/AttaClipWineGame.exe",image)
    wine=shutil.which("wine64") or "/usr/lib/wine/wine64"
    fixture=launch([wine,str(image),"UnrelatedArgument.exe"],"wine")
    helper=launch([str(runtime/"attaclip-recorder"),str(runtime)],"native",True)
    import threading
    def read():
        for line in helper.stdout: events.append(json.loads(line))
    threading.Thread(target=read,daemon=True).start();wait(lambda e:e["event"]=="ready")
    candidate=None
    for attempt in range(150):
        previous=len(events);command(dict(action="candidates"))
        current=next(e for e in events[previous:] if e["event"]=="candidates")
        candidate=next((v for v in current["windows"] if v["name"]=="AttaClip private Wine proof"),None)
        if candidate:break
        time.sleep(.5)
    assert candidate,candidate
    pid=candidate["pid"]
    assert candidate["runtime"]=="wine",candidate
    assert pathlib.Path(candidate["executable"]).resolve()==image.resolve(),candidate
    assert pathlib.Path(candidate["runtimeExecutable"]).name in ["wine64","wine64-preloader","wine","wine-preloader"],candidate
    assert "UnrelatedArgument.exe" in candidate.get("arguments", ""),"Verified PID arguments must support shared-runtime catalog matching"
    command(dict(action="start",sourceKind="auto",resolvedKind="app",sourceId=candidate["id"],pid=pid,sourceName="Private Wine game",quality="custom",customWidth=640,customHeight=360,customFPS=24,customCQ=28,clipSeconds=2,captureAudio=False,microphone=False,allowSoftwareEncoder=True))
    time.sleep(4)
    file=folder/"wine-window.mkv"
    command(dict(action="save",path=str(file),requestId="wine-window",requestedAt=int(time.time()*1000)))
    wait(lambda event:event["event"]=="saved" and event.get("requestId")=="wine-window")
    subprocess.run(["ffmpeg","-v","error","-i",str(file),"-f","null","-"],check=True)
    pixel=subprocess.check_output(["ffmpeg","-v","error","-ss","0.4","-i",str(file),"-vf","crop=2:2:iw/2:ih/2","-frames:v","1","-pix_fmt","rgb24","-f","rawvideo","-"])
    assert pixel[2]>180 and pixel[0]<40 and pixel[1]<40,pixel
    frames=[]
    for timestamp in ["0.2","0.8"]:
        frames.append(subprocess.check_output(["ffmpeg","-v","error","-ss",timestamp,"-i",str(file),"-frames:v","1","-f","image2pipe","-c:v","png","-"]))
    assert frames[0]!=frames[1],"Saved Wine frames must actually change"
    fixture.terminate();fixture.wait(timeout=10);time.sleep(1)
    previous=len(events);command(dict(action="status"))
    state=next(event for event in events[previous:] if event["event"]=="status")
    assert state["waiting"] and state["availableSeconds"]>1.5,state
    command(dict(action="stop"))
    (folder/"wine-proof.json").write_text(json.dumps(dict(candidate=candidate,pixel=list(pixel),actualWineVersion=subprocess.check_output([wine,"--version"],text=True).strip()),indent=2))
    print("Real Wine leading PE identity, ignored later executable argument, changing pixels and saved capture passed",folder)
    helper.stdin.write('{"action":"exit"}\n');helper.stdin.flush();assert helper.wait(timeout=10)==0
finally:
    if "wine" in locals(): subprocess.run(["/usr/lib/wine/wineserver","-k"],env=env,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    for process in reversed(processes):
        if process.poll() is None:
            process.terminate()
            try: process.wait(timeout=5)
            except subprocess.TimeoutExpired: process.kill()
    for log in logs: log.close()
    (folder/"events.json").write_text(json.dumps(events,indent=2))
    import shutil
    shutil.rmtree(private)
