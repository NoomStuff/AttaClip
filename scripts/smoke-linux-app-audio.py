"""Selected application audio, multiple inputs and source switching on private servers."""
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
    pulse=launch(["pulseaudio", "-n", "--daemonize=no", "--exit-idle-time=-1", "--use-pid-file=no", "--disable-shm=true", "--load=module-native-protocol-unix socket=" + str(private / "audio.sock") + " auth-anonymous=1", "--load=module-null-sink sink_name=attaclip-test rate=48000 channels=2"], "pulse")
    deadline = time.monotonic() + 10
    while not (private / "audio.sock").exists():
        assert time.monotonic() < deadline, "Private PulseAudio did not start"
        time.sleep(0.1)
    if os.environ.get("ATTACLIP_TEST_X11_APP"):
        launch(["openbox", "--sm-disable"], "window-manager")
        time.sleep(1)
    launch(["openbox", "--sm-disable"], "window-manager")
    helper = launch([str(runtime / "attaclip-recorder"), str(runtime)], "native", True)
    import threading, math, array
    def read():
        for line in helper.stdout: events.append(json.loads(line))
    threading.Thread(target=read,daemon=True).start()
    wait(lambda event:event["event"]=="ready")
    title="AttaClip selected audio " + str(uuid.uuid4())
    fixture_binary=root/".cache/native-tests-linux/attaclip-x11-audio-fixture"
    assert fixture_binary.exists(), "Build native/tests for the real Linux audio fixture first"
    fixture=launch([str(fixture_binary),title,"997"],"selected")
    unrelated=launch(["ffplay","-v","error","-f","lavfi","-i","sine=frequency=1234:sample_rate=48000","-nodisp"],"unrelated")
    candidate=None
    for attempt in range(40):
        previous=len(events)
        command(dict(action="candidates"))
        current=next(event for event in events[previous:] if event["event"]=="candidates")
        candidate=next((v for v in current["windows"] if v["name"]==title),None)
        if candidate: break
        time.sleep(.2)
    assert candidate and candidate["pid"]==fixture.pid, candidate
    config=dict(sourceKind="app",sourceId=candidate["id"],pid=candidate["pid"],sourceName=title,quality="custom",customWidth=640,customHeight=360,customFPS=24,customCQ=28,clipSeconds=2,microphone=False,allowSoftwareEncoder=True,captureAudio=True)
    command(dict(config,action="start"))
    measured={}
    for name,gain,mute in [("full",1,False),("half",.5,False),("muted",1,True)]:
        command(dict(action="audio",source="capture",volume=gain,muted=mute))
        time.sleep(4)
        file=folder/(name+".mkv")
        command(dict(action="save",path=str(file),requestId=name,requestedAt=int(time.time()*1000)))
        wait(lambda event:event["event"]=="saved" and event.get("requestId")==name)
        subprocess.run(["ffmpeg","-v","error","-i",str(file),"-f","null","-"],check=True)
        amplitudes=[]
        for track in range(2):
            raw=subprocess.check_output(["ffmpeg","-v","error","-i",str(file),"-map",f"0:a:{track}","-ac","1","-ar","48000","-f","f32le","-"])
            pcm=array.array("f",raw)[24000:72000]
            def amplitude(frequency):
                powers=[]
                for offset in range(0,len(pcm)-4800+1,4800):
                    segment=pcm[offset:offset+4800]
                    a=sum(value*(.5-.5*math.cos(2*math.pi*i/(len(segment)-1)))*math.cos(2*math.pi*frequency*i/48000) for i,value in enumerate(segment))
                    b=sum(value*(.5-.5*math.cos(2*math.pi*i/(len(segment)-1)))*math.sin(2*math.pi*frequency*i/48000) for i,value in enumerate(segment))
                    powers.append((4*math.hypot(a,b)/len(segment))**2)
                return 20*math.log10(max(1e-10,math.sqrt(sum(powers)/len(powers))))
            amplitudes.append(dict(selected=amplitude(997),secondInput=amplitude(1499),descendant=amplitude(1999),unrelated=amplitude(1234)))
        measured[name]=amplitudes
        for track in range(2): amplitudes[track]["meanVolume"]=volume(file,track)
    print(json.dumps(measured,indent=2), flush=True)
    for track in range(2):
        assert measured["full"][track]["selected"]>-40, measured
        assert measured["full"][track]["secondInput"]>-40, measured
        assert measured["full"][track]["descendant"]>-40, measured
        assert measured["full"][track]["unrelated"]<min(-50,measured["full"][track]["selected"]-20), measured
        assert abs(measured["full"][track]["meanVolume"]-measured["half"][track]["meanVolume"]-6.02)<1, measured
        assert measured["muted"][track]["selected"]<-70, measured
    second_title="AttaClip other selected audio " + str(uuid.uuid4())
    second=launch([str(fixture_binary),second_title,"577"],"second-selected")
    other=None
    for attempt in range(40):
        previous=len(events);command(dict(action="candidates"))
        current=next(event for event in events[previous:] if event["event"]=="candidates")
        other=next((v for v in current["windows"] if v["name"]==second_title),None)
        if other: break
        time.sleep(.2)
    assert other and other["pid"]==second.pid, other
    command(dict(config,action="source",sourceId=other["id"],pid=other["pid"],sourceName=second_title))
    command(dict(action="audio",source="capture",volume=1,muted=False))
    time.sleep(4)
    file=folder/"switched.mkv"
    command(dict(action="save",path=str(file),requestId="switched",requestedAt=int(time.time()*1000)))
    wait(lambda event:event["event"]=="saved" and event.get("requestId")=="switched")
    subprocess.run(["ffmpeg","-v","error","-i",str(file),"-f","null","-"],check=True)
    raw=subprocess.check_output(["ffmpeg","-v","error","-i",str(file),"-map","0:a:0","-ac","1","-ar","48000","-f","f32le","-"])
    pcm=array.array("f",raw)[24000:72000]
    switched=dict(selected=amplitude(577),previous=amplitude(997),unrelated=amplitude(1234))
    assert switched["selected"]>-40 and switched["previous"]<-50 and switched["unrelated"]<-50, switched
    measured["switched"]=switched
    packets=json.loads(subprocess.check_output(["ffprobe","-v","error","-show_packets","-show_streams","-of","json",str(file)],text=True))
    endpoints={}
    for packet in packets["packets"]:
        index=packet["stream_index"]
        endpoints[index]=max(endpoints.get(index,0),float(packet.get("pts_time",0))+float(packet.get("duration_time",0)))
    assert all(abs(endpoints[index]-endpoints[0])<.15 for index in endpoints if index),endpoints
    measured["switchedEndpoints"]=endpoints
    command(dict(action="stop"))
    extras=[dict(id="fixture-a",name="Selected A",includeInMaster=False,kind="application",sourceId=candidate["id"],pid=candidate["pid"],volume=1,muted=False,enabled=True),dict(id="fixture-b",name="Selected B",kind="application",sourceId=other["id"],pid=other["pid"],volume=1,muted=False,enabled=True)]
    command(dict(config,action="start",captureAudio=False,audioSources=extras))
    time.sleep(4)
    file=folder/"additional.mkv"
    command(dict(action="save",path=str(file),requestId="additional",requestedAt=int(time.time()*1000)))
    wait(lambda event:event["event"]=="saved" and event.get("requestId")=="additional")
    streams=json.loads(subprocess.check_output(["ffprobe","-v","error","-show_streams","-of","json",str(file)],text=True))["streams"]
    assert [v["tags"]["title"] for v in streams if v["codec_type"]=="audio"]==["Master","Capture audio","Selected A","Selected B"],streams
    additional=[]
    for track in range(4):
        raw=subprocess.check_output(["ffmpeg","-v","error","-i",str(file),"-map",f"0:a:{track}","-ac","1","-ar","48000","-f","f32le","-"])
        pcm=array.array("f",raw)[24000:72000]
        additional.append(dict(a=amplitude(997),b=amplitude(577),unrelated=amplitude(1234)))
    assert additional[0]["a"]<-50 and additional[0]["b"]>-40,additional
    assert volume(file,1)<-70,additional
    assert additional[2]["a"]>-40 and additional[2]["b"]<-50,additional
    assert additional[3]["b"]>-40 and additional[3]["a"]<-50,additional
    assert all(v["unrelated"]<-50 for v in additional),additional
    command(dict(action="audio",source="fixture-a",volume=1,muted=True));time.sleep(4)
    muted_extra=folder/"muted-additional.mkv"
    command(dict(action="save",path=str(muted_extra),requestId="muted-additional",requestedAt=int(time.time()*1000)))
    wait(lambda event:event["event"]=="saved" and event.get("requestId")=="muted-additional")
    assert volume(muted_extra,2)<-70 and volume(muted_extra,3)>-50
    measured["additional"]=additional
    assert any(e.get("additional",{}).get("fixture-a",0)>.05 for e in events if e["event"]=="audio-levels")
    assert any(e.get("additional",{}).get("fixture-b",0)>.05 for e in events if e["event"]=="audio-levels")
    # A stopped private audio server must invalidate recording rather than
    # silently substitute desktop audio or claim a healthy capture.
    pulse.terminate();pulse.wait(timeout=5);time.sleep(1)
    previous=len(events);command(dict(action="status"))
    current=next(event for event in events[previous:] if event["event"]=="status")
    assert current["waiting"] and "audio" in current["message"].lower(),current
    command(dict(action="stop"))
    helper.stdin.write('{"action":"exit"}\n');helper.stdin.flush()
    assert helper.wait(timeout=10)==0
    (folder/"measurements.json").write_text(json.dumps(measured,indent=2))
    print("Selected application audio isolation passed",folder)
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
