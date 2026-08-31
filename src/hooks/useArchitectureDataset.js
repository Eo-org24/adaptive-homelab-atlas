import { useState, useEffect, useCallback } from "react";
import { base44 } from "@/api/base44Client";
import { loadArchitectureDataset } from "@/lib/datasetLoader";

// Complete architecture-dataset hook for architecture-wide operations.
// Unlike useAllEntities (display-only, caps + swallows errors), this exposes
// completeness metadata. Callers MUST check `complete` and surface
// "DATASET INCOMPLETE" rather than presenting partial results as authoritative.
export function useArchitectureDataset(names) {
  const [data, setData] = useState({});
  const [complete, setComplete] = useState(true);
  const [errors, setErrors] = useState({});
  const [incompleteEntities, setIncompleteEntities] = useState([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    const res = await loadArchitectureDataset(base44, names);
    setData(res.data);
    setComplete(res.complete);
    setErrors(res.errors);
    setIncompleteEntities(res.incompleteEntities);
    setLoading(false);
  }, [names.join(",")]);

  useEffect(() => { load(); }, [load]);

  return { data, complete, errors, incompleteEntities, loading, refresh: load };
}