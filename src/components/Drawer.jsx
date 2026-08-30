import React, { useEffect } from "react";
import { X } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";

export default function Drawer({ open, onClose, title, subtitle, children, footer, width = "max-w-xl" }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="fixed inset-0 bg-black/50 z-40 backdrop-blur-sm"
            onClick={onClose}
          />
          <motion.div
            initial={{ x: "100%" }} animate={{ x: 0 }} exit={{ x: "100%" }}
            transition={{ type: "spring", damping: 30, stiffness: 300 }}
            className={`fixed right-0 top-0 bottom-0 w-full ${width} bg-background border-l border-border z-50 flex flex-col shadow-2xl`}
          >
            <div className="flex items-start justify-between px-5 py-4 border-b border-border">
              <div className="min-w-0">
                <h2 className="text-base font-semibold truncate">{title}</h2>
                {subtitle && <p className="text-xs text-muted-foreground mt-0.5 truncate">{subtitle}</p>}
              </div>
              <button onClick={onClose} className="text-muted-foreground hover:text-foreground p-1 rounded-md hover:bg-muted">
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto px-5 py-4">{children}</div>
            {footer && <div className="px-5 py-3 border-t border-border flex justify-end gap-2">{footer}</div>}
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}