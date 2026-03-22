require('dotenv').config({ path: './gemini.env' });

async function checkMyModels() {
    const apiKey = process.env.GEMINI_API_KEY;
    console.log("Checking Google's servers...");
    
    try {
        const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`);
        const data = await response.json();

        if (data.models) {
            console.log("\n✅ SUCCESS! Here are the exact model names you can use:");
            console.log("--------------------------------------------------");
            data.models.forEach(model => {
                // We only want models that support text generation
                if (model.supportedGenerationMethods.includes("generateContent")) {
                    // This strips out the "models/" part so you get the exact string you need
                    console.log(`👉 ${model.name.replace('models/', '')}`);
                }
            });
            console.log("--------------------------------------------------");
        } else {
            console.log("❌ Something went wrong:", data);
        }
    } catch (error) {
        console.error("Fetch failed:", error);
    }
}

checkMyModels();