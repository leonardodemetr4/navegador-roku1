const form = document.getElementById("browseForm");
const input = document.getElementById("url");
const message = document.getElementById("message");

function normalizeUrl(value) {
  const text = value.trim();
  if (!/^https?:\/\//i.test(text)) return `https://${text}`;
  return text;
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  const url = normalizeUrl(input.value);
  try {
    new URL(url);
  } catch {
    message.textContent = "Digite uma URL válida.";
    return;
  }

  message.textContent = "Abrindo página...";
  window.location.href = `/browse?url=${encodeURIComponent(url)}`;
});

document.querySelectorAll("[data-url]").forEach((button) => {
  button.addEventListener("click", () => {
    input.value = button.dataset.url;
    form.requestSubmit();
  });
});
