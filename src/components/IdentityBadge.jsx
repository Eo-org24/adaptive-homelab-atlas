import React from "react";
import { badgeClass } from "@/lib/homelab";

// Distinguishes CANONICAL (from canonical import, has canonical_id + source_kind=canonical)
// vs ATLAS LOCAL (manually created or pre-import local records with no canonical_id).
// Used wherever duplicate-looking names appear so a local record with the same
// display name as a canonical record does not visually masquerade as the same
// canonical identity. Name equality is NOT identity equality.
export default function IdentityBadge({ record }) {
  if (!record) return null;
  const isCanonical = !!(record.canonical_id && record.source_kind === "canonical");
  if (isCanonical) {
    return (
      <span
        className={`${badgeClass("zinc")} font-mono text-[10px]`}
        title={`Canonical identity: ${record.canonical_id}`}
      >
        CANONICAL
      </span>
    );
  }
  return (
    <span
      className={`${badgeClass("orange")} border border-dashed border-current text-[10px]`}
      title="Atlas-local record — not a canonical identity"
    >
      ATLAS LOCAL
    </span>
  );
}