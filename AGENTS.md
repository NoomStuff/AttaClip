# AttaClip

We are building a local-first, cross-platform clipping app. Save a moment, make it small enough to share, and get back to what you were doing. It should be simple enough to leave running without thinking about it, while keeping the user in control of their recordings and files.

## What we optimize for

1. Trust. A saved clip contains the requested moment, with working playback and synchronized audio. A fast save of the wrong footage is a failure.
2. Low impact. Recording must remain dependable during gameplay. Library work and compression must not compromise capture. Measure the cost instead of assuming hardware encoding makes it free.
3. Simplicity and polish. Common actions should feel immediate. Use compact controls, useful feedback, and sensible defaults. Don't turn every technical detail into another setting or ask users to understand video engineering.

## Keep the job small

AttaClip captures recent footage, previews clips, and creates shareables. Full-session recording belongs in OBS. Cutting belongs in AttaCut. Growth needs a reason tied to making clipping or sharing better, rather than turning this into another recording studio or editor.

Reuse AttaCut where its experience fits, without inheriting its trimming assumptions. Capture and clip hotkeys must work independently of the library UI. Navigating or closing that UI must not interrupt recording.

## The user's files are theirs

The folder is the collection. Existing supported videos should work without registration, and files must remain usable outside AttaClip. Metadata supports the collection; it must not become a requirement for accessing the videos. Moving a whole collection should preserve its relationships.

An original is the saved recording. A shareable is a compressed version linked to it. Creating or canceling a shareable never modifies its original. Verify the finished copy fits its size target. Missing files or damaged metadata never authorize deleting other files. Don't reorganize existing collections without an explicit choice.

## No silent surprises

The user decides when and what to record. Never silently broaden application capture to the desktop. Saving delays must not shift a clip away from the moment requested. Status must describe what is actually working, and success means the file is complete.

Keep uploads and telemetry out of the default experience. Losing requested footage requires an informed choice. Preserve these guarantees when changing recovery, shutdown, updates, or background work.

Verify recording and export changes against actual media and failure cases, using isolated files rather than the user's collection. Platform builds alone don't establish working capture. Preserve license obligations when reusing code, without complicating the architecture solely to create a license boundary.
