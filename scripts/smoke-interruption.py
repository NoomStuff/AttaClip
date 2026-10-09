"""Real capture test on a private X11 display and private PulseAudio sink."""
import json
import os
import pathlib
import signal
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
    xvfb=launch(["Xvfb",f":{display}","-screen","0","640x360x24","-nolisten","unix","-listen","tcp","-ac"],"xvfb")
    deadline=time.monotonic()+10
    while True:
        assert xvfb.poll() is None,"Private display exited"
        try:
            socket.create_connection(("127.0.0.1",6000+display),timeout=.2).close();break
        except OSError:
            assert time.monotonic()<deadline,"Private display did not start"
            time.sleep(.1)
    launch(["pulseaudio","-n","--daemonize=no","--exit-idle-time=-1","--use-pid-file=no","--disable-shm=true","--load=module-native-protocol-unix socket="+str(private/"audio.sock")+" auth-anonymous=1","--load=module-null-sink sink_name=attaclip-test rate=48000 channels=2"],"pulse")
    deadline=time.monotonic()+10
    while not (private/"audio.sock").exists():
        assert time.monotonic()<deadline,"Private PulseAudio did not start"
        time.sleep(.1)
    launch(["openbox","--sm-disable"],"window-manager")
    fixture=launch(["ffplay","-v","error","-f","lavfi","-i","testsrc2=size=320x180:rate=24:duration=120","-window_title","AttaClip interruption proof","-an"],"fixture")
    gate=folder/"writer-gate"
    env["ATTACLIP_NATIVE_TEST_WRITER_GATE"]=str(gate)
    helper=launch([str(runtime/"attaclip-recorder"),str(runtime)],"native",True)
    import threading
    def read():
        for line in helper.stdout:events.append(json.loads(line))
    threading.Thread(target=read,daemon=True).start()
    wait(lambda event:event["event"]=="ready")
    candidate=None
    for attempt in range(40):
        previous=len(events);command(dict(action="candidates"))
        current=next(event for event in events[previous:] if event["event"]=="candidates")
        candidate=next((value for value in current["windows"] if value["name"]=="AttaClip interruption proof"),None)
        if candidate:break
        time.sleep(.2)
    assert candidate,"Animated private application missing"
    command(dict(action="start",sourceKind="app",sourceId=candidate["id"],pid=candidate["pid"],sourceName="Interruption proof",quality="custom",customWidth=640,customHeight=360,customFPS=24,customCQ=28,clipSeconds=2,captureAudio=False,microphone=False,allowSoftwareEncoder=True))
    for attempt in range(100):
        previous=len(events);command(dict(action="status"))
        state=next(event for event in events[previous:] if event["event"]=="status")
        if not state["waiting"] and state["availableSeconds"]>1.8:break
        time.sleep(.2)
    assert state["availableSeconds"]>1.8,state
    command(dict(action="save",path=str(folder/"before.mkv"),requestId="before",requestedAt=int(time.time()*1000)))
    time.sleep(.15)
    os.kill(helper.pid,signal.SIGSTOP)
    time.sleep(4)
    os.kill(helper.pid,signal.SIGCONT)
    gate.touch()
    saved=wait(lambda event:event["event"]=="saved" and event.get("requestId")=="before")
    time.sleep(1.5)
    command(dict(action="save",path=str(folder/"after.mkv"),requestId="after",requestedAt=int(time.time()*1000)))
    wait(lambda event:event["event"]=="saved" and event.get("requestId")=="after")
    results={}
    for name in ["before","after"]:
        file=folder/(name+".mkv")
        subprocess.run(["ffmpeg","-v","error","-i",str(file),"-f","null","-"],check=True)
        probe=json.loads(subprocess.check_output(["ffprobe","-v","error","-select_streams","v:0","-show_packets","-show_format","-of","json",str(file)]))
        pts=[float(packet["pts_time"]) for packet in probe["packets"]]
        maximum=max(b-a for a,b in zip(pts,pts[1:]))
        duration=float(probe["format"]["duration"])
        assert maximum<.2,(name,"Video timestamp gap survived interruption",maximum)
        assert .3<duration<3.5,(name,"Unexpected duration",duration)
        results[name]=dict(duration=duration,maximumFrameInterval=maximum)
    command(dict(action="stop"))
    helper.stdin.write('{"action":"exit"}\n');helper.stdin.flush();assert helper.wait(timeout=10)==0
    (folder/"interruption-proof.json").write_text(json.dumps(results,indent=2))
    print("Real SIGSTOP/resume preserved accepted save and restarted continuous decodable footage",results,folder)
finally:
    if "helper" in locals() and helper.poll() is None:
        os.kill(helper.pid,signal.SIGCONT)
    for process in reversed(processes):
        if process.poll() is None:
            process.terminate()
            try:process.wait(timeout=5)
            except subprocess.TimeoutExpired:process.kill()
    for log in logs:log.close()
    (folder/"events.json").write_text(json.dumps(events,indent=2))
    import shutil
    shutil.rmtree(private)
