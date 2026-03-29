import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";
import fs from "fs-extra";
import { exec } from "child_process";
import { promisify } from "util";
import { GoogleGenAI } from "@google/genai";

const execPromise = promisify(exec);

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json());

  const INPUT_DIR = path.join(process.cwd(), "input_repository");
  const OUTPUT_DIR = path.join(process.cwd(), "output_repository");

  await fs.ensureDir(INPUT_DIR);
  await fs.ensureDir(OUTPUT_DIR);

  // API Routes
  app.get("/api/files", async (req, res) => {
    try {
      const inputs = await fs.readdir(INPUT_DIR);
      const outputs = await fs.readdir(OUTPUT_DIR);
      res.json({ inputs, outputs });
    } catch (error) {
      res.status(500).json({ error: "Failed to list files" });
    }
  });

  app.post("/api/files/create", async (req, res) => {
    const { name, content, type } = req.body;
    const dir = type === "input" ? INPUT_DIR : OUTPUT_DIR;
    try {
      await fs.writeFile(path.join(dir, name), content);
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ error: "Failed to create file" });
    }
  });

  app.get("/api/files/content", async (req, res) => {
    const { name, type } = req.query;
    const dir = type === "input" ? INPUT_DIR : OUTPUT_DIR;
    try {
      const content = await fs.readFile(path.join(dir, name as string), "utf-8");
      res.json({ content });
    } catch (error) {
      res.status(500).json({ error: "Failed to read file" });
    }
  });

  app.post("/api/run", async (req, res) => {
    const { code, language, inputFileName } = req.body;
    
    let inputFileContent = "";
    if (inputFileName) {
      try {
        inputFileContent = await fs.readFile(path.join(INPUT_DIR, inputFileName), "utf-8");
      } catch (e) {
        // Ignore if file doesn't exist
      }
    }

    if (language === "python") {
      const tempFile = path.join(process.cwd(), `temp_${Date.now()}.py`);
      const tempInputFile = path.join(process.cwd(), `temp_input_${Date.now()}.txt`);
      
      try {
        await fs.writeFile(tempFile, code);
        if (inputFileContent) {
          await fs.writeFile(tempInputFile, inputFileContent);
        }

        const cmd = inputFileContent 
          ? `python3 ${tempFile} < ${tempInputFile}` 
          : `python3 ${tempFile}`;
        
        const { stdout, stderr } = await execPromise(cmd);
        
        // Write to output repository if needed
        const outputFileName = `output_${Date.now()}.txt`;
        await fs.writeFile(path.join(OUTPUT_DIR, outputFileName), stdout);

        res.json({ stdout, stderr, outputFileName });
      } catch (error: any) {
        res.json({ stdout: error.stdout, stderr: error.stderr || error.message });
      } finally {
        await fs.remove(tempFile);
        await fs.remove(tempInputFile);
      }
    } else if (language === "cobol") {
      // For COBOL, we'll use Gemini to "simulate" the execution if cobc is not available
      // But we'll try to run it first
      try {
        const tempFile = path.join(process.cwd(), `temp_${Date.now()}.cob`);
        await fs.writeFile(tempFile, code);
        
        // Check if cobc is available
        try {
          await execPromise("cobc --version");
          // If available, compile and run
          const binFile = tempFile.replace(".cob", "");
          await execPromise(`cobc -x -o ${binFile} ${tempFile}`);
          const { stdout, stderr } = await execPromise(`./${binFile}`);
          
          const outputFileName = `output_${Date.now()}.txt`;
          await fs.writeFile(path.join(OUTPUT_DIR, outputFileName), stdout);
          
          res.json({ stdout, stderr, outputFileName });
          await fs.remove(binFile);
        } catch (e) {
          // If cobc is NOT available, use Gemini to simulate
          const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
          const prompt = `
            Act as a COBOL compiler and runtime.
            Given the following COBOL code and input file content, provide the expected STDOUT and any STDERR.
            
            COBOL CODE:
            ${code}
            
            INPUT FILE CONTENT:
            ${inputFileContent}
            
            Return ONLY a JSON object with "stdout" and "stderr" fields.
          `;
          const response = await ai.models.generateContent({
            model: "gemini-3-flash-preview",
            contents: prompt,
            config: { responseMimeType: "application/json" }
          });
          
          const result = JSON.parse(response.text);
          const outputFileName = `output_${Date.now()}.txt`;
          await fs.writeFile(path.join(OUTPUT_DIR, outputFileName), result.stdout);
          
          res.json({ ...result, outputFileName, simulated: true });
        } finally {
          await fs.remove(tempFile);
        }
      } catch (error: any) {
        res.json({ error: error.message });
      }
    } else {
      res.status(400).json({ error: "Language not supported yet" });
    }
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
