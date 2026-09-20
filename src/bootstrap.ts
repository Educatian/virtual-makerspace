const mode = new URLSearchParams(window.location.search).get("mode");

if (mode === "xr") {
  const app = document.querySelector<HTMLDivElement>("#app");
  if (app) {
    app.id = "scene-container";
    app.style.width = "100vw";
    app.style.height = "100vh";
  }
  void import("./index.js");
} else {
  void import("./desktop/main.js");
}
