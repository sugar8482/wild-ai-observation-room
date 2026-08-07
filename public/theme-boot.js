(() => {
  try {
    const theme = localStorage.getItem("wild-ai-observation-room.theme.v1");
    document.documentElement.dataset.theme = theme === "dark" ? "dark" : "light";
  } catch {
    document.documentElement.dataset.theme = "light";
  }
})();
