import React from "react";
import { badgeClass } from "@/lib/homelab";

export default function StatusBadge({ value, tone }) {
  return <span className={badgeClass(tone)}>{(value || "").replace(/_/g, " ")}</span>;
}