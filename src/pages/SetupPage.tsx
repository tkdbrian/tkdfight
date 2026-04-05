import { useState } from "react";
import { useTournamentStore, type CompetitorEntry } from "@/store/tournament";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { UserPlus, Pencil, Trash2, Swords, AlertCircle } from "lucide-react";
import { generateRoundRobin } from "@/lib/bracket";
import { cn } from "@/lib/utils";

type FormData = { name: string; team: string; weight: string };
const EMPTY_FORM: FormData = { name: "", team: "", weight: "" };

export function SetupPage() {
  const {
    competitors,
    config,
    fights,
    phase,
    addCompetitor,
    removeCompetitor,
    updateCompetitor,
    setConfig,
    setFights,
    setPhase,
  } = useTournamentStore();

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<FormData>(EMPTY_FORM);
  const [formError, setFormError] = useState("");

  function openAdd() {
    setForm(EMPTY_FORM);
    setEditingId(null);
    setFormError("");
    setDialogOpen(true);
  }

  function openEdit(c: CompetitorEntry) {
    setForm({ name: c.name, team: c.team ?? "", weight: c.weight?.toString() ?? "" });
    setEditingId(c.id);
    setFormError("");
    setDialogOpen(true);
  }

  function handleSave() {
    if (!form.name.trim()) {
      setFormError("El nombre es obligatorio.");
      return;
    }
    const weightNum = form.weight ? Number(form.weight) : undefined;
    if (form.weight && (Number.isNaN(weightNum) || (weightNum ?? 0) <= 0)) {
      setFormError("El peso debe ser un número positivo.");
      return;
    }
    const data = {
        name: form.name.trim(),
        team: form.team.trim() || undefined,
        weight: weightNum,
      };
    if (editingId) {
      updateCompetitor(editingId, data);
    } else {
      addCompetitor(data);
    }
    setDialogOpen(false);
  }

  function handleStart() {
    const generated = generateRoundRobin(competitors);
    setFights(generated);
    setPhase("fighting");
  }

  const canStart = competitors.length >= 2 && config.categoryName.trim() !== "";

  return (
    <div className="flex-1 overflow-auto p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Configuración del Torneo</h1>
          <p className="text-muted-foreground text-sm mt-0.5">
            Agrega competidores y configura la categoría antes de comenzar.
          </p>
        </div>
        <Button onClick={handleStart} disabled={!canStart} size="lg">
          <Swords className="size-4" />
          Iniciar Torneo
        </Button>
      </div>

      {/* Category */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Categoría</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="max-w-sm space-y-1.5">
            <Label htmlFor="category">Nombre de la categoría</Label>
            <Input
              id="category"
              placeholder="Ej: Cadetes -45 kg masculino"
              value={config.categoryName}
              onChange={(e) => setConfig({ categoryName: e.target.value })}
            />
          </div>
        </CardContent>
      </Card>

      {/* Competitors */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0">
          <CardTitle className="text-base">
            Competidores
            <Badge variant="secondary" className="ml-2">
              {competitors.length}
            </Badge>
          </CardTitle>
          <Button variant="outline" size="sm" onClick={openAdd}>
            <UserPlus className="size-4" />
            Agregar
          </Button>
        </CardHeader>
        <CardContent>
          {competitors.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-muted-foreground gap-2">
              <AlertCircle className="size-8 opacity-40" />
              <p className="text-sm">No hay competidores. Agrega al menos 2 para comenzar.</p>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-8">#</TableHead>
                  <TableHead>Nombre</TableHead>
                  <TableHead>Equipo</TableHead>
                  <TableHead>Peso (kg)</TableHead>
                  <TableHead className="text-right">Acciones</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {competitors.map((c, i) => (
                  <TableRow key={c.id}>
                    <TableCell className="text-muted-foreground">{i + 1}</TableCell>
                    <TableCell className="font-medium">{c.name}</TableCell>
                    <TableCell className="text-muted-foreground">{c.team ?? "—"}</TableCell>
                    <TableCell className="text-muted-foreground">
                      {c.weight ?? "—"}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex items-center justify-end gap-1">
                        <Button
                          variant="ghost"
                          size="icon"
                          className="size-7"
                          onClick={() => openEdit(c)}
                        >
                          <Pencil className="size-3.5" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className={cn("size-7 text-destructive hover:text-destructive")}
                          onClick={() => removeCompetitor(c.id)}
                        >
                          <Trash2 className="size-3.5" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Fights preview */}
      {phase === "setup" && fights.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Enfrentamientos generados</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {fights.map((f, i) => (
                <div
                  key={f.id}
                  className="flex items-center justify-between gap-2 rounded-md border border-border px-3 py-2 text-sm"
                >
                  <span className="text-muted-foreground w-6 text-right">{i + 1}.</span>
                  <span className="flex-1 text-right font-medium">{f.red.name}</span>
                  <span className="text-muted-foreground text-xs px-2">vs</span>
                  <span className="flex-1 font-medium">{f.blue.name}</span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Add / Edit Dialog */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editingId ? "Editar competidor" : "Agregar competidor"}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-1.5">
              <Label htmlFor="name">Nombre *</Label>
              <Input
                id="name"
                placeholder="Nombre completo"
                value={form.name}
                onChange={(e) => { setForm((f) => ({ ...f, name: e.target.value })); setFormError(""); }}
                onKeyDown={(e) => e.key === "Enter" && handleSave()}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="team">Equipo / Club</Label>
              <Input
                id="team"
                placeholder="Opcional"
                value={form.team}
                onChange={(e) => setForm((f) => ({ ...f, team: e.target.value }))}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="weight">Peso (kg)</Label>
              <Input
                id="weight"
                type="number"
                placeholder="Opcional"
                value={form.weight}
                onChange={(e) => setForm((f) => ({ ...f, weight: e.target.value }))}
              />
            </div>
            {formError && (
              <p className="text-destructive text-sm flex items-center gap-1.5">
                <AlertCircle className="size-3.5" /> {formError}
              </p>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>
              Cancelar
            </Button>
            <Button onClick={handleSave}>{editingId ? "Guardar" : "Agregar"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
