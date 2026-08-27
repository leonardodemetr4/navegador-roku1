const form = document.getElementById("searchForm");
const input = document.getElementById("url");
const browser = document.getElementById("browser");
const status = document.getElementById("status");

form.addEventListener("submit", async (event) => {
  event.preventDefault();

  let url = input.value.trim();

  if (!url) {
    return;
  }

  if (!/^https?:\/\//i.test(url)) {
    url = "https://" + url;
  }

  status.textContent = "Abrindo " + url + "...";

  browser.src = "/browse?url=" + encodeURIComponent(url);

  browser.onload = () => {
    status.textContent = "Página carregada.";
  };

  browser.onerror = () => {
    status.textContent = "Não foi possível carregar a página.";
  };
});
