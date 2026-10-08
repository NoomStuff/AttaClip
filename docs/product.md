# Product decisions

This records the working design from the product discussions and mock review. It is a specification reference, not a list of instructions every code change needs to repeat. Prototype findings can change the mechanics while preserving the product's intent.

## Layout and interaction

Recording, Library, the persistent clip viewer, and Settings share a narrow navigation rail. Page navigation preserves view state. Returning to the viewer restores the last deliberately opened clip, version, and playback position. Leaving pauses playback. Newly saved clips do not replace a deliberate selection.

The UI uses the purple from the mock, near-black backgrounds, slightly lighter rounded surfaces, sparse borders, and smooth interaction feedback. Shortcuts animate their corresponding controls. The recording preview and video get space; controls stay compact.

A quiet bottom strip spans all views. It communicates actual recording health, session time, and available clip history. Waiting and errors replace reassuring recording status. Everyday UI avoids internal terms such as replay buffer.

## Capture and audio

Manual start and stop are the defaults. Launch with the OS and start recording when the app opens are separate opt-in settings. Closing the window hides it to the tray or menu bar. Stop clears unsaved history. Accepted save requests retain their footage. Exit stops capture and uses a shared finish, cancel-work, or keep-open flow for pending work, with another warning before discarding original saves.

The default source is the main screen. Selected applications can be ordinary apps. Auto game detection is an intended source option, not permission to start recording. Desktop fallback is off unless explicitly enabled and must be apparent in recording status. Source switches retain history and automatically fit sources inside a fixed recording output.

One configurable clip duration defaults to one minute. Each accepted request ends at its keypress. Multiple durations are deferred. Overlapping clips are normal; optional overlap avoidance starts after the previous successful save and must not hide footage after a failed save.

Mixer controls follow OBS's familiar meter, mute, and level pattern. Automatically route each captured audio source to an isolated track and a master mix. Track limits and the distinction between disabled and muted need prototype refinement. There is no routing matrix in the everyday UI. Desktop and application audio must not unintentionally duplicate the game.

## Library and sharing

The chosen folder is both the save destination and the collection. Supported existing videos are discovered recursively without an import step. Its name is visible in the Library sidebar, with reveal available. Folder switching lives in settings. Existing files are not automatically rearranged.

Folder layout and filename presets are independent settings. Single-folder storage is the starting default; application folders are optional. Custom filename formatting is advanced. Changes affect new clips, and collisions never overwrite.

Custom overlapping categories are in the first-version scope. They are metadata groupings, not physical folders. Application labels are independent. Removing a category does not remove its videos.

The root `.attaclip` folder holds associations. A root `shareables` folder mirrors originals' relative folders. AttaClip verifies ownership before treating a pre-existing folder as its shareable output area. Relative paths take priority over absolute recovery hints. External recovery must be disclosed and must not grant deletion ownership.

Cards open the viewer. A hover/focus three-dot menu can create shareables directly without opening a video. The viewer has Original and Shareable switching, multiple-shareable selection, basic clip information, and actions at the bottom. Source playback controls follow AttaCut, including audio-track selection. Open in AttaCut launches the editing app.

Shareables preserve duration and default to master audio. A persistent default maximum size is set once; per-clip overrides do not change it. Explicit creation starts immediately even while recording. Automatic creation is off by default. Copies persist and can be deleted independently. Whole-clip deletion includes linked copies and prefers system trash. Automatic deletion and bulk copy cleanup are deferred.

## First setup and feedback

Setup covers source, audio with optional microphone, clip length/shortcut/folder, quality, sharing size, and final startup choices. Show Low, Standard, and High profiles with actual dimensions and frame rate. Hardware capability checks support recommendations; they do not prove game performance. Custom encoding controls remain a refinement target. No separate test-clip wizard step. Finish ready, or begin recording only when the user enables that preference.

Saving, saved, and failed feedback runs without opening the library. Popups and sound are independent and enabled initially. Visual visibility offers everywhere, outside fullscreen, or off. Smooth cross-platform native feedback remains an integration target, with real exclusive-fullscreen behavior to verify.

Diagnostics remain local. Errors state what failed, what still works, and the next action. Updates install only explicitly, with recording and pending-work safeguards. Exact quality profiles, safe MP4 integration, HDR, and platform capabilities require empirical validation.
