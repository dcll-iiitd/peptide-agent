/* ── Small anchored dropdown menu (Phase 8i extraction) ───────────────────
   Generalized from HistoryPage.js's (Phase 8d) per-item [⋮] menu toggle,
   which Phase 8i's Export button needs an identical version of —
   extracted as the second real consumer rather than duplicated.

   Only one dropdown can be open at a time (module-level state), which
   matches how every consumer so far actually behaves: opening a new one
   always closes whichever was previously open. anchorSelector is the CSS
   selector for the clickable region that should NOT count as "outside"
   (so clicking the menu's own toggle button doesn't immediately re-close
   it via the outside-click handler). */
let openDropdownId = null;
let outsideHandler = null;
let escHandler = null;

export function toggleDropdown(dropdownId, anchorSelector) {
  const menu = document.getElementById(dropdownId);
  if (!menu) return;
  const wasOpen = menu.style.display === 'block';
  closeDropdown();
  if (!wasOpen) {
    menu.style.display = 'block';
    openDropdownId = dropdownId;
    outsideHandler = (e) => { if (!e.target.closest(anchorSelector)) closeDropdown(); };
    escHandler = (e) => { if (e.key === 'Escape') closeDropdown(); };
    document.addEventListener('click', outsideHandler);
    document.addEventListener('keydown', escHandler);
  }
}

export function closeDropdown() {
  if (openDropdownId) {
    const menu = document.getElementById(openDropdownId);
    if (menu) menu.style.display = 'none';
    openDropdownId = null;
  }
  if (outsideHandler) { document.removeEventListener('click', outsideHandler); outsideHandler = null; }
  if (escHandler) { document.removeEventListener('keydown', escHandler); escHandler = null; }
}
