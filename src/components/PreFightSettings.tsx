import type * as React from "react";
import { Button } from "@/components/ui/button";
export interface PreFightSettingsProps {
  seconds: string; rounds: number; allowRounds: boolean; inputId: string;
  onChange: (seconds: string, rounds: number | null) => void;
  onReset: () => void; onSave?: () => void;
  dirty: boolean; busy: boolean; disabled: boolean; whiteBand: boolean;
}
export function PreFightSettings(props: PreFightSettingsProps): React.JSX.Element {
  const {seconds,rounds,allowRounds,onChange,onReset,onSave,dirty,busy,disabled,whiteBand,inputId}=props;
  const chosenRounds = rounds;
  const durationLabel = seconds === "60" ? "1 minuto" : seconds === "90" ? "1 minuto y 30 segundos" : seconds === "120" ? "2 minutos" : `${seconds} segundos`;
  return <fieldset disabled={disabled || busy} className="flex flex-col items-center gap-2 text-xs max-w-xs">
    <legend className="text-center font-semibold mb-2">Ajustes de este combate</legend>
    <div className="flex gap-1">{[[40,"40 s"],[60,"1 min"],[90,"1:30"],[120,"2 min"]].map(([value,label]) =>
      <Button type="button" size="sm" variant={Number(seconds)===value ? "secondary":"outline"} key={value} onClick={() => onChange(String(value),allowRounds ? chosenRounds : null)}>{label}</Button>)}</div>
    <label htmlFor={inputId}>Duración por round (segundos)</label>
    <input id={inputId} type="number" min={1} max={3600} step={1} value={seconds} onChange={(event) => onChange(event.target.value,allowRounds ? chosenRounds : null)} className="w-24 rounded-md border border-input bg-background px-2 py-1.5 text-center font-bold" />
    {allowRounds && <div className="flex gap-2">{([1,2] as const).map((count) => <Button type="button" size="sm" variant={rounds===count ? "secondary":"outline"} key={count} onClick={() => onChange(seconds,count)}>{count} {count===1 ? "round":"rounds"}</Button>)}</div>}
    <p>{rounds} {rounds===1 ? "round":"rounds"} de {durationLabel}</p>
    {whiteBand && (seconds!=="40" || rounds!==1) && <p role="alert" className="text-amber-300">Blancos y Puntas Amarillas: este ajuste se aparta de 1 round de 40 segundos.</p>}
    <Button type="button" variant="ghost" size="sm" onClick={onReset}>Restablecer valores de la categoría</Button>
    {onSave && <Button type="button" size="sm" disabled={!dirty || busy} onClick={onSave}>{busy ? "Guardando…":"Guardar ajustes"}</Button>}
    {dirty && <p className="text-amber-300">Solo cambia esta pelea.{onSave ? " Guardá los ajustes antes de iniciar.":""}</p>}
  </fieldset>;
}
