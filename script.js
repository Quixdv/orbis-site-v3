const API_URL = "https://orbis-api.jsifta52.workers.dev";

async function generateCode() {
    const input = document.getElementById("input").value.trim();

    if (!input) {
        alert("Zadej URL.");
        return;
    }

    const result = document.getElementById("result");
    result.innerHTML = "Generuji kód...";

    try {
        const response = await fetch(`${API_URL}/create`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                url: input
            })
        });

        const data = await response.json();

        if (data.success) {
            result.innerHTML = `
                <div style="font-size: 32px; font-weight: bold;">
                    ${data.code}
                </div>
            `;
        } else {
            result.textContent = data.error || "Neznámá chyba.";
        }
    } catch (error) {
        console.error(error);
        result.textContent = "Network Error: " + error.message;
    }
}
