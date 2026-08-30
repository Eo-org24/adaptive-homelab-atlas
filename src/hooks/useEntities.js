import { useState, useEffect, useCallback } from "react";
import { base44 } from "@/api/base44Client";

// Loads all records for an entity with simple caching + refresh.
export function useEntities(entityName, sort = "-updated_date", limit = 500) {
  const [data, setData] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const recs = await base44.entities[entityName].list(sort, limit);
      setData(recs);
      setError(null);
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
    }
  }, [entityName, sort, limit]);

  useEffect(() => { load(); }, [load]);

  return { data, loading, error, refresh: load, setData };
}

// Loads several entities at once.
export function useAllEntities(names) {
  const [data, setData] = useState({});
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    const entries = await Promise.all(
      names.map(async (n) => {
        try { return [n, await base44.entities[n].list("-updated_date", 500)]; }
        catch { return [n, []]; }
      })
    );
    setData(Object.fromEntries(entries));
    setLoading(false);
  }, [names.join(",")]);

  useEffect(() => { load(); }, [load]);

  return { data, loading, refresh: load };
}