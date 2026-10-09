"""Exercise macOS controlled imports, PNG thumbnails and exact decoded pixels."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile

project = Path.cwd()
directory = project / "work/controlled-media/macos-arm64"
controlled = directory / "ffmpeg"
probe = directory / "ffprobe"
reference = Path(os.environ["ATTACLIP_REFERENCE_FFMPEG"])
if controlled.resolve() == reference.resolve():
    raise RuntimeError("Use an independent reference FFmpeg to generate fixtures")
temporary = Path(tempfile.mkdtemp(prefix="attaclip-macos-codecs-"))

def run(binary, args):
    return subprocess.check_output([str(binary), "-hide_banner", "-loglevel", "error", "-nostdin", "-threads", "1", *args], stderr=subprocess.PIPE, timeout=120)

fixtures = [
    ("h264-aac.mp4", "libx264", "aac", ["-preset", "ultrafast"]),
    ("hevc-10bit.mkv", "libx265", "aac", ["-pix_fmt", "yuv420p10le", "-preset", "ultrafast", "-x265-params", "pools=1:frame-threads=1:log-level=error"]),
    ("av1-aac.mp4", "libaom-av1", "aac", ["-cpu-used", "8", "-threads", "1", "-crf", "35"]),
    ("vp9-opus.webm", "libvpx-vp9", "libopus", ["-deadline", "realtime", "-cpu-used", "8", "-threads", "1"]),
    ("vp8-vorbis.webm", "libvpx", "libvorbis", ["-deadline", "realtime", "-cpu-used", "8", "-threads", "1"]),
    ("h264-flac.mkv", "libx264", "flac", ["-preset", "ultrafast"]),
    ("h264-mp3.mkv", "libx264", "libmp3lame", ["-preset", "ultrafast"]),
    ("h264-pcm.mov", "libx264", "pcm_s16le", ["-preset", "ultrafast"]),
]
results = []
for name, video, audio, options in fixtures:
    clip = temporary / name
    run(reference, ["-f", "lavfi", "-i", "testsrc2=size=160x90:rate=24", "-f", "lavfi", "-i", "sine=frequency=550:sample_rate=48000", "-t", "1.25", "-c:v", video, *options, "-c:a", audio, "-y", str(clip)])
    info = json.loads(subprocess.check_output([str(probe), "-v", "error", "-show_streams", "-show_format", "-of", "json", str(clip)], timeout=20))
    duration = float(info["format"]["duration"])
    assert 1.2 <= duration <= 1.4, (name, duration)
    assert any(stream.get("codec_type") == "audio" for stream in info["streams"]), name
    run(controlled, ["-xerror", "-i", str(clip), "-map", "0:v:0", "-map", "0:a:0", "-f", "null", "/dev/null"])
    pixels = []
    for label, binary in [("reference", reference), ("controlled", controlled)]:
        png = temporary / f"{name}.{label}.png"
        run(binary, ["-i", str(clip), "-map", "0:v:0", "-frames:v", "1", "-c:v", "png", "-y", str(png)])
        pixels.append(run(reference, ["-i", str(png), "-frames:v", "1", "-pix_fmt", "rgb24", "-f", "rawvideo", "pipe:1"]))
    assert pixels[0] == pixels[1], f"Decoded first frame differs: {name}"
    results.append({"format": name, "duration": duration, "fullDecode": True, "firstFrameMatches": True})
    print(f"Passed {name}", flush=True)
verification = directory / "verification"
verification.mkdir(exist_ok=True)
(verification / "codecs.json").write_text(json.dumps({"controlledSha256": hashlib.sha256(controlled.read_bytes()).hexdigest(), "referenceSha256": hashlib.sha256(reference.read_bytes()).hexdigest(), "results": results}, indent=2) + "\n")
print(f"macOS controlled media passed {len(results)} independent fixtures. Proof in {verification}")
