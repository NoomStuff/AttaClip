"""Actual exact-window XWayland, Wine audio privacy and target-loss capture."""
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
    config.write_text("output HEADLESS-1 mode 640x360@60Hz\noutput HEADLESS-1 bg #0022ff solid_color\nseat seat0 fallback true\nxwayland force\nfor_window [title=AttaClip] floating enable, border none\n")
    sway = launch(["sway", "--unsupported-gpu", "-c", str(config)], "sway")
    deadline = time.monotonic() + 10
    while True:
        sockets = [file for file in private.glob("wayland-*") if not file.name.endswith(".lock")]
        if sockets:
            break
        assert sway.poll() is None and time.monotonic() < deadline, "Private Sway could not start"
        time.sleep(0.1)
    env["WAYLAND_DISPLAY"] = sockets[0].name
    deadline = time.monotonic()+15
    while True:
        display = None
        for entry in pathlib.Path('/proc').iterdir():
            if not entry.name.isdigit(): continue
            try:
                stat = (entry/'stat').read_text().rsplit(')',1)[1].split()
                args = (entry/'cmdline').read_bytes().split(b'\0')
                if pathlib.Path(args[0].decode()).name == 'Xwayland' and ('XDG_RUNTIME_DIR=' + str(private)).encode() in (entry/'environ').read_bytes().split(b'\0'):
                    display = next((arg.decode() for arg in args if re.fullmatch(rb':\d+', arg)), None)
                    break
            except (OSError, ValueError): pass
        if display: break
        assert sway.poll() is None and time.monotonic()<deadline, 'Owned XWayland did not start'
        time.sleep(.1)
    env['DISPLAY'] = display
    print('Owned Sway XWayland started', display, flush=True)
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
    subprocess.run(["ffmpeg", "-v", "error", "-f", "lavfi", "-i", "sine=frequency=1234:sample_rate=48000:duration=180", "-ac", "2", str(tone)], check=True)
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
    assert ready["captureBackend"] == "wayland-portal" and ready["sourceKinds"] == ["screen", "app", "auto"] and ready["applicationBackend"] == "xwayland" and ready["portalPicker"] is True, ready
    import array, math
    env['SDL_VIDEODRIVER']='x11'
    selected=launch([str(root/'.cache/native-tests-linux/attaclip-x11-audio-fixture'),'AttaClip selected','997'],'selected')
    def candidate(title):
        for attempt in range(300):
            before=len(events);command(dict(action='candidates'))
            found=wait(lambda e:e['event']=='candidates',start=before)
            match=next((v for v in found['windows'] if v['name']==title),None)
            if match:return match
            time.sleep(.2)
        raise AssertionError('Selected target not found')
    target=candidate('AttaClip selected')
    assert target['pid']==selected.pid,target
    print('Exact XWayland candidate verified', target['id'],flush=True)
    # The animated Wayland test source remains visible behind the small X11
    # window. It must never enter the selected-window recording.
    settings=dict(sourceKind='app',sourceId=target['id'],pid=target['pid'],sourceName=target['name'],quality='custom',customWidth=640,customHeight=360,customFPS=24,customCQ=28,clipSeconds=2,captureAudio=True,microphone=False,allowSoftwareEncoder=True)
    for source_kind, resolved in [('screen','screen'),('auto','screen')]:
        rejection=command(dict(settings,action='start',sourceKind=source_kind,resolvedKind=resolved,sourceId='screen:0:0'),'error')
        assert 'system screen picker' in rejection['message'],rejection
        command(dict(action='stop'))
    command(dict(settings,action='start',sourceKind='auto',resolvedKind='waiting'))
    waiting=status()
    assert waiting['waiting'] and waiting['availableSeconds']==0,waiting
    command(dict(action='stop'))
    command(dict(settings,action='start'))
    state(lambda v:not v['waiting'] and v['availableSeconds']>=1.8)
    time.sleep(2)
    def save(name):
        file=folder/(name+'.mkv')
        command(dict(action='save',path=str(file),requestId=name,requestedAt=int(time.time()*1000)))
        saved=wait(lambda e:e['event']=='saved' and e.get('requestId')==name)
        subprocess.run(['ffmpeg','-v','error','-i',str(file),'-enc_time_base','demux','-f','null','-'],check=True)
        frames=subprocess.check_output(['ffmpeg','-v','error','-i',str(file),'-map','0:v:0','-pix_fmt','rgb24','-f','rawvideo','-'])
        frame_size=640*360*3
        assert len(frames)>=20*frame_size
        centers=[tuple(frames[offset+(180*640+320)*3:offset+(180*640+320)*3+3]) for offset in range(0,len(frames),frame_size)]
        assert all(pixel[2]>220 and pixel[0]<30 and pixel[1]<30 for pixel in centers),centers[:10]
        if name in ['selected','closed']:
            blue=sum(frames[i+2]>220 and frames[i]<30 and frames[i+1]<30 for i in range(0,len(frames),3))/ (len(frames)//3)
            assert blue>.95, ('Selected pixmap contains unrelated pixels',blue)
        distinct=len({hashlib.sha256(frames[offset:offset+frame_size]).hexdigest() for offset in range(0,len(frames),frame_size)})
        assert distinct>20,distinct
        return file,saved,distinct
    file,saved,distinct=save('selected')
    levels=[]
    for track in range(2):
        raw=subprocess.check_output(['ffmpeg','-v','error','-i',str(file),'-map',f'0:a:{track}','-ac','1','-ar','48000','-f','f32le','-'])
        pcm=array.array('f',raw)[24000:72000]
        def amplitude(hz):
            powers=[]
            for offset in range(0,len(pcm)-4800+1,4800):
                values=pcm[offset:offset+4800]
                a=sum(v*(.5-.5*math.cos(2*math.pi*i/(len(values)-1)))*math.cos(2*math.pi*hz*i/48000) for i,v in enumerate(values))
                b=sum(v*(.5-.5*math.cos(2*math.pi*i/(len(values)-1)))*math.sin(2*math.pi*hz*i/48000) for i,v in enumerate(values))
                powers.append((4*math.hypot(a,b)/len(values))**2)
            return 20*math.log10(max(1e-10,math.sqrt(sum(powers)/len(powers))))
        levels.append(dict(selected=amplitude(997),second=amplitude(1499),child=amplitude(1999),unrelated=amplitude(997+237)))
    for level in levels:
        assert level['selected']>-40 and level['second']>-40 and level['child']>-40, levels
        assert level['unrelated']<-50, levels
    print('Actual XWayland frames',distinct,'audio',levels,flush=True)
    queued=folder/'queued-app.mkv'
    command(dict(action='save',path=str(queued),requestId='queued-app',requestedAt=int(time.time()*1000)))
    portalsettings=dict(settings,sourceKind='screen',sourceId='portal:screen',sourceName='Portal-selected screen')
    begin=time.monotonic();command(dict(portalsettings,action='source'))
    assert time.monotonic()-begin<3,'Switch waited for the portal grant'
    assert status()['waiting']
    wait(lambda e:e['event']=='saved' and e.get('requestId')=='queued-app')
    subprocess.run(['ffmpeg','-v','error','-i',str(queued),'-enc_time_base','demux','-f','null','-'],check=True)
    state(lambda v:not v['waiting'] and v['availableSeconds']>=1.8)
    time.sleep(2)
    portalfile=folder/'portal.mkv'
    command(dict(action='save',path=str(portalfile),requestId='portal',requestedAt=int(time.time()*1000)))
    portal_saved=wait(lambda e:e['event']=='saved' and e.get('requestId')=='portal')
    assert portal_saved['source']=='Portal-selected screen',portal_saved
    portal_media=decode(portalfile)
    command(dict(settings,action='source'))
    state(lambda v:not v['waiting'] and v['availableSeconds']>=1.8)
    time.sleep(4)
    if os.environ.get('ATTACLIP_XWAYLAND_ADAPTER_TEST'):
        command(dict(action='stop'))
        bun = shutil.which('bun') or str(pathlib.Path.home()/'.bun/bin/bun')
        subprocess.run([bun, 'scripts/smoke-xwayland-adapter.ts', str(runtime), str(folder/'adapter-native'), target['id']], env=env, cwd=root, check=True)
        command(dict(settings,action='start'))
        state(lambda v:not v['waiting'] and v['availableSeconds']>=1.8)
        time.sleep(2)
    selected.terminate();selected.wait(timeout=5)
    state(lambda v:v['waiting'])
    time.sleep(4)
    lost,lostevent,lostdistinct=save('closed')
    assert lostevent.get('previousFootage'),lostevent
    command(dict(action='stop'))
    env['WINEPREFIX']=str(private/'wine-prefix');env['WINEARCH']='win64';env['WINEDEBUG']='-all';env['WINEDLLOVERRIDES']='winemenubuilder.exe=d'
    image=folder/'My Game/AttaClipWineGame.exe';image.parent.mkdir()
    shutil.copyfile(root/'.cache/native-tests-linux/AttaClipWineGame.exe',image)
    wine=shutil.which('wine64') or '/usr/lib/wine/wine64'
    win=launch([wine,str(image),'UnrelatedArgument.exe'],'wine')
    target=candidate('AttaClip private Wine proof')
    assert target.get('runtime')=='wine' and pathlib.Path(target['executable']).resolve()==image.resolve(),target
    assert 'UnrelatedArgument.exe' in target['arguments'],target
    print('Actual XWayland Wine identity verified',flush=True)
    command(dict(settings,action='start',sourceKind='auto',resolvedKind='app',sourceId=target['id'],pid=target['pid'],sourceName=target['name'],captureAudio=True))
    state(lambda v:not v['waiting'] and v['availableSeconds']>=1.8)
    time.sleep(2)
    winefile,_,wineframes=save('wine')
    winelevels=[]
    for track in range(2):
        raw=subprocess.check_output(['ffmpeg','-v','error','-i',str(winefile),'-map',f'0:a:{track}','-ac','1','-ar','48000','-f','f32le','-'])
        pcm=array.array('f',raw)[24000:72000]
        winelevels.append(dict(selected=amplitude(777),unrelated=amplitude(1234)))
    assert all(level['selected']>-40 and level['unrelated']<-50 for level in winelevels),winelevels
    print('Actual Wine selected audio',winelevels,flush=True)
    if os.environ.get('ATTACLIP_XWAYLAND_ADAPTER_TEST'):
        command(dict(action='stop'))
        bun = shutil.which('bun') or str(pathlib.Path.home()/'.bun/bin/bun')
        subprocess.run([bun, 'scripts/smoke-xwayland-adapter.ts', str(runtime), str(folder/'adapter-wine'), target['id']], env=env, cwd=root, check=True)
        command(dict(settings,action='start',sourceKind='auto',resolvedKind='app',sourceId=target['id'],pid=target['pid'],sourceName=target['name'],captureAudio=True))
        state(lambda v:not v['waiting'] and v['availableSeconds']>=1.8)
        time.sleep(2)
    win.terminate();win.wait(timeout=5)
    state(lambda v:v['waiting'])
    time.sleep(4)
    _,wineloss,_=save('wine-closed');assert wineloss.get('previousFootage'),wineloss
    command(dict(action='stop'));helper.stdin.write('{"action":"exit"}\n');helper.stdin.flush();assert helper.wait(timeout=10)==0
    proof=dict(appFrames=distinct,closedFrames=lostdistinct,wineFrames=wineframes,audio=levels,wineAudio=winelevels,portal=portal_media,binaryHashes={name:hashlib.sha256((runtime/name).read_bytes()).hexdigest() for name in ["attaclip-recorder","obs-plugins/linux-pipewire.so"]},checks=["exact-window-moving-pixels","native-and-Wine-PID","application-and-descendant-audio","unrelated-desktop-audio-excluded","Wine-PE-leading-identity","required-process-argument","auto-waiting-without-desktop","explicit-auto-portal-fallback","queued-save-survives-app-to-portal","portal-to-app-switch","last-valid-history-after-app-and-Wine-loss","full-decode","clean-exit"])
    (folder/'xwayland-proof.json').write_text(json.dumps(proof,indent=2)+'\n')
    print('Actual XWayland app/Wine proof passed',folder,flush=True)
finally:
    if env.get('WINEPREFIX'):subprocess.run(['/usr/lib/wine/wineserver64','-k'],env=env,capture_output=True)
    for process in reversed(processes):
        if process.poll() is None:
            process.terminate()
            try:process.wait(timeout=5)
            except subprocess.TimeoutExpired:process.kill();process.wait(timeout=5)
    for log in logs:log.close()
    (folder/'events.json').write_text(json.dumps(events,indent=2)+'\n')
    shutil.rmtree(private)
