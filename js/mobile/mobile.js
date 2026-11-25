const helpDialog = document.querySelector("#connect-dialog");
const openHelp = () => { helpDialog.hidden = false; };
const closeHelp = () => { helpDialog.hidden = true; };

document.querySelector("#scan-help")?.addEventListener("click", openHelp);
document.querySelector("#close-dialog")?.addEventListener("click", closeHelp);
document.querySelector("#confirm-dialog")?.addEventListener("click", closeHelp);
document.querySelector("#refresh-page")?.addEventListener("click", () => window.location.reload());
document.querySelector("#desktop-mode")?.addEventListener("click", () => {
  window.location.href = "/";
});

helpDialog?.addEventListener("click", (event) => {
  if (event.target === helpDialog) closeHelp();
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && helpDialog && !helpDialog.hidden) closeHelp();
});
