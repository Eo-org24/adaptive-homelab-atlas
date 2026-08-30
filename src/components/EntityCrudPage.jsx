import React, { useState, useEffect, useMemo } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Plus, Search, Download, Pencil, Trash2, FileJson, FileSpreadsheet, ExternalLink } from "lucide-react";
import { useEntities } from "@/hooks/useEntities";
import EntityForm from "@/components/EntityForm";
import Drawer from "@/components/Drawer";
import { PageHeader, EmptyState } from "@/components/ui-bits";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from "@/components/ui/dialog";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { base44 } from "@/api/base44Client";
import { exportJSON, exportCSV } from "@/lib/homelab";

// Generic CRUD page. `enrich(record) -> record` resolves display fields live
// from canonical records so renames propagate; the form only persists schema
// fields. detailRender(record, { goTo }).
export default function EntityCrudPage({
  entityName, title, description, columns, searchKeys = [], filters = [],
  refOptions = {}, detailRender, exportColumns, focusId, hidden = [], actions, initialFilters = {},
  fieldOverrides, enrich = (r) => r,
}) {
  const { data, loading, refresh } = useEntities(entityName);
  const [query, setQuery] = useState("");
  const [filterVals, setFilterVals] = useState(initialFilters);
  const [editing, setEditing] = useState(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [detailId, setDetailId] = useState(null);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const navigate = useNavigate();
  const [params] = useSearchParams();

  const rows = useMemo(() => (data || []).map(enrich), [data, enrich]);
  const detailRow = rows.find((r) => r.id === detailId) || null;

  // Sync detail to ?focus= (cross-page navigation) without fighting row clicks.
  useEffect(() => {
    const f = focusId || params.get("focus");
    if (f && data.length) setDetailId(f);
  }, [focusId, params, data]);

  const filtered = useMemo(() => {
    let out = rows;
    if (query.trim()) {
      const q = query.toLowerCase();
      out = out.filter((r) => searchKeys.some((k) => String(r[k] ?? "").toLowerCase().includes(q)));
    }
    filters.forEach((f) => {
      const v = filterVals[f.key];
      if (v && v !== "__all") out = out.filter((r) => (f.get ? f.get(r) : r[f.key]) === v);
    });
    return out;
  }, [rows, query, filterVals, searchKeys, filters]);

  const openNew = () => { setEditing({}); setDialogOpen(true); };
  const openEdit = (r) => { setEditing(r); setDialogOpen(true); };

  const submit = async (vals) => {
    if (editing.id) await base44.entities[entityName].update(editing.id, vals);
    else await base44.entities[entityName].create(vals);
    setDialogOpen(false);
    setEditing(null);
    refresh();
  };

  const doDelete = async () => {
    await base44.entities[entityName].delete(deleteTarget.id);
    setDeleteTarget(null);
    if (detailId === deleteTarget.id) setDetailId(null);
    refresh();
  };

  const goTo = (route, id) => navigate(`${route}?focus=${id}`);

  return (
    <div className="p-4 xl:p-6 max-w-[1760px] mx-auto">
      <PageHeader
        title={title}
        description={description}
        actions={
          <>
            {actions}
            {exportColumns && (
              <Button variant="outline" size="sm" onClick={() => exportCSV(filtered, exportColumns, entityName.toLowerCase())}>
                <FileSpreadsheet className="w-3.5 h-3.5 mr-1.5" /> CSV
              </Button>
            )}
            <Button variant="outline" size="sm" onClick={() => exportJSON(filtered, entityName.toLowerCase())}>
              <FileJson className="w-3.5 h-3.5 mr-1.5" /> JSON
            </Button>
            <Button size="sm" onClick={openNew}>
              <Plus className="w-3.5 h-3.5 mr-1.5" /> New
            </Button>
          </>
        }
      />

      <div className="flex flex-col sm:flex-row gap-2 mb-3">
        <div className="relative flex-1 max-w-sm">
          <Search className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="pl-8"
          />
        </div>
        {filters.map((f) => (
          <select
            key={f.key}
            value={filterVals[f.key] || "__all"}
            onChange={(e) => setFilterVals((p) => ({ ...p, [f.key]: e.target.value }))}
            className="rounded-md border border-input bg-background px-3 py-2 text-sm capitalize"
          >
            <option value="__all">{f.label}: all</option>
            {f.options.map((o) => <option key={o.value} value={o.value}>{o.label || o.value.replace(/_/g, " ")}</option>)}
          </select>
        ))}
      </div>

      <div className="rounded-xl border border-border bg-card overflow-hidden">
        {loading ? (
          <div className="p-8 text-center text-sm text-muted-foreground">Loading…</div>
        ) : filtered.length === 0 ? (
          <EmptyState title="No records" sub="Adjust filters or create a new record." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-muted-foreground">
                <tr>
                  {columns.map((c) => (
                    <th key={c.key} className={`text-left font-medium px-3 py-2 whitespace-nowrap ${c.className || ""}`}>{c.label}</th>
                  ))}
                  <th className="w-px"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {filtered.map((r) => (
                  <tr key={r.id} className="hover:bg-muted/30 cursor-pointer" onClick={() => setDetailId(r.id)}>
                    {columns.map((c) => {
                      const v = c.get ? c.get(r) : r[c.key];
                      return (
                        <td key={c.key} className={`px-3 py-2 align-top ${c.className || ""}`}>
                          {c.render ? c.render(r, { goTo }) : c.tone ? (
                            <span className={`inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset ${c.tone(r)}`}>{String(v ?? "—")}</span>
                          ) : (
                            <span className={c.mono ? "font-mono text-xs" : ""}>{c.mono ? String(v ?? "—") : (v == null || v === "" ? "—" : String(v))}</span>
                          )}
                        </td>
                      );
                    })}
                    <td className="px-2 py-2">
                      <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
                        <button onClick={() => openEdit(r)} className="p-1.5 rounded-md hover:bg-muted text-muted-foreground hover:text-foreground"><Pencil className="w-3.5 h-3.5" /></button>
                        <button onClick={() => setDeleteTarget(r)} className="p-1.5 rounded-md hover:bg-muted text-muted-foreground hover:text-rose-500"><Trash2 className="w-3.5 h-3.5" /></button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Create / Edit */}
      <Dialog open={dialogOpen} onOpenChange={(o) => { setDialogOpen(o); if (!o) setEditing(null); }}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editing?.id ? "Edit" : "New"} {title}</DialogTitle>
            <DialogDescription>{description}</DialogDescription>
          </DialogHeader>
          {editing && (
            <EntityForm
              entityName={entityName}
              initial={editing}
              onSubmit={submit}
              onCancel={() => { setDialogOpen(false); setEditing(null); }}
              refOptions={refOptions}
              fieldOverrides={fieldOverrides}
              hidden={hidden}
            />
          )}
        </DialogContent>
      </Dialog>

      {/* Detail drawer */}
      <Drawer
        open={!!detailRow}
        onClose={() => { setDetailId(null); if (params.get("focus")) navigate(window.location.pathname, { replace: true }); }}
        eyebrow={entityName}
        title={detailRow ? (detailRow.hostname || detailRow.name || detailRow.title || detailRow.task || detailRow.target_name || "Detail") : ""}
        subtitle={detailRow ? (detailRow.description || detailRow.model || detailRow.port_identifier || "") : ""}
        footer={detailRow && (
          <>
            <Button variant="ghost" size="sm" onClick={() => { setDetailId(null); navigate(window.location.pathname); }}><ExternalLink className="w-3.5 h-3.5 mr-1.5" />View all</Button>
            <span className="ml-auto flex items-center gap-2">
              <Button variant="outline" size="sm" onClick={() => openEdit(detailRow)}><Pencil className="w-3.5 h-3.5 mr-1.5" />Edit</Button>
              <Button variant="outline" size="sm" onClick={() => exportJSON([detailRow], `${entityName.toLowerCase()}-${detailRow.id}`)}><FileJson className="w-3.5 h-3.5 mr-1.5" />Export</Button>
            </span>
          </>
        )}
      >
        {detailRow && detailRender && detailRender(detailRow, { goTo })}
      </Drawer>

      {/* Delete confirm */}
      <AlertDialog open={!!deleteTarget} onOpenChange={(o) => !o && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this record?</AlertDialogTitle>
            <AlertDialogDescription>This cannot be undone. Records referencing it will show a broken link until updated.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={doDelete} className="bg-rose-600 hover:bg-rose-700 text-white">Delete</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}