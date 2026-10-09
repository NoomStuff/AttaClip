import { useEffect, useState } from "react";
import { MoreHorizontal, Plus, Volume2, VolumeX } from "lucide-react";
import type { AdditionalAudioSource, GameCandidate, Preferences } from "../../shared/types";
import { api, Button, IconButton, LevelSlider, Menu, Select, Toggle } from "./ui";
import type { Run } from "./ui";

export function AdditionalAudio({
   preferences,
   active,
   visible,
   levels,
   save,
   run,
}: {
   preferences: Preferences;
   active: boolean;
   visible: boolean;
   levels: Record<string, number>;
   save: (patch: Partial<Preferences> | ((current: Preferences) => Partial<Preferences>)) => void;
   run: Run;
}) {
   const [adding, setAdding] = useState(false);
   const [kind, setKind] = useState<AdditionalAudioSource["kind"]>("application");
   const [candidates, setCandidates] = useState<GameCandidate[]>([]);
   const [devices, setDevices] = useState<{ id: string; name: string }[]>([]);
   const [selected, setSelected] = useState("");
   const [include, setInclude] = useState(false);
   const [loading, setLoading] = useState(false);
   useEffect(() => {
      if (!adding || !visible || active) return;
      let cancelled = false;
      setLoading(true);
      setSelected("");
      void run(async () => {
         if (kind === "application") {
            const items = await api.games();
            if (!cancelled) {
               setCandidates(items);
               setSelected(items[0]?.id ?? "");
            }
         } else {
            const items = await api.audioDevices(kind);
            if (!cancelled) {
               setDevices(items);
               setSelected(items[0]?.id ?? "");
            }
         }
      }).finally(() => {
         if (!cancelled) setLoading(false);
      });
      return () => {
         cancelled = true;
      };
   }, [adding, kind, visible, active, run]);
   const update = (id: string, patch: Partial<AdditionalAudioSource>) =>
      save((current) => ({ audioSources: current.audioSources.map((source) => (source.id === id ? { ...source, ...patch } : source)) }));
   const add = () => {
      const app = kind === "application" ? candidates.find((item) => item.id === selected) : undefined;
      const device = kind !== "application" ? devices.find((item) => item.id === selected) : undefined;
      if (!app && !device) return;
      save((current) => ({
         audioSources: [
            ...current.audioSources,
            {
               id: crypto.randomUUID(),
               name: app?.gameName ?? app?.name ?? device!.name,
               kind,
               sourceId: app?.id ?? "",
               executable: app?.executable ?? "",
               deviceId: device?.id ?? "",
               enabled: true,
               volume: 1,
               muted: false,
               includeInMaster: include,
            },
         ],
      }));
      setAdding(false);
   };
   return (
      <>
         {preferences.audioSources.map((source) => (
            <div className="audio-row extra-audio" key={source.id}>
               <IconButton
                  label={`${source.muted ? "Unmute" : "Mute"} ${source.name}`}
                  disabled={!source.enabled}
                  onClick={() => update(source.id, { muted: !source.muted })}
               >
                  {source.muted ? <VolumeX size={18} /> : <Volume2 size={18} />}
               </IconButton>
               <div className="audio-row-content">
                  <Toggle label={source.name} checked={source.enabled} disabled={active} onChange={(enabled) => update(source.id, { enabled })} />
                  <div className="meter" style={{ "--meter": `${levels[source.id] ?? 0}%` } as React.CSSProperties}>
                     <div className="meter-fill" />
                  </div>
                  <LevelSlider
                     label={`${source.name} level`}
                     value={source.volume}
                     disabled={!source.enabled}
                     onCommit={(volume) => update(source.id, { volume })}
                  />
                  <span className="meter-caption">
                     {!source.enabled
                        ? "Not recorded"
                        : source.muted
                          ? "Muted in all recorded tracks"
                          : source.includeInMaster
                            ? "Master mix and isolated track"
                            : "Isolated track only"}
                  </span>
               </div>
               <Menu label={`${source.name} options`} trigger={<MoreHorizontal size={16} />}>
                  <button disabled={active} onClick={() => update(source.id, { includeInMaster: !source.includeInMaster })}>
                     {source.includeInMaster ? "Exclude from master" : "Include in master"}
                  </button>
                  <button disabled={active} onClick={() => save((current) => ({ audioSources: current.audioSources.filter((item) => item.id !== source.id) }))}>
                     Remove source
                  </button>
               </Menu>
            </div>
         ))}
         {adding && !active ? (
            <div className="audio-source-form">
               <Select label="Audio source type" value={kind} onChange={(value) => setKind(value as AdditionalAudioSource["kind"])}>
                  <option value="application">Application</option>
                  <option value="input">Input device</option>
                  <option value="output">Output device</option>
               </Select>
               <Select label="Audio source" value={selected} disabled={loading} onChange={setSelected}>
                  <option value="">{loading ? "Loading sources…" : "Choose a source"}</option>
                  {(kind === "application" ? candidates : devices).map((item) => (
                     <option key={item.id} value={item.id}>
                        {item.name}
                     </option>
                  ))}
               </Select>
               <Toggle
                  label="Include in master mix"
                  checked={include}
                  onChange={setInclude}
                  detail="Leave off if capture audio already includes this source."
               />
               <div className="audio-source-actions">
                  <Button onClick={() => setAdding(false)}>Cancel</Button>
                  <Button className="primary" disabled={loading || !selected} onClick={add}>
                     Add source
                  </Button>
               </div>
            </div>
         ) : (
            preferences.audioSources.length < 3 && (
               <Button
                  className="audio-add"
                  disabled={active}
                  title={active ? "Stop recording to add audio sources" : undefined}
                  onClick={() => {
                     setInclude(!preferences.captureAudio);
                     setAdding(true);
                  }}
               >
                  <Plus size={14} /> Add audio source
               </Button>
            )
         )}
      </>
   );
}
