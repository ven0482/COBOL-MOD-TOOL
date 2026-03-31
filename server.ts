import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";
import fs from "fs-extra";
import { exec } from "child_process";
import { promisify } from "util";

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

  app.delete("/api/files", async (req, res) => {
    const { name, type } = req.query;
    const dir = type === "input" ? INPUT_DIR : OUTPUT_DIR;
    try {
      const filePath = path.join(dir, name as string);
      if (await fs.pathExists(filePath)) {
        await fs.remove(filePath);
        res.json({ success: true });
      } else {
        res.status(404).json({ error: "File not found" });
      }
    } catch (error) {
      res.status(500).json({ error: "Failed to delete file" });
    }
  });

  app.put("/api/files/rename", async (req, res) => {
    const { oldName, newName, type } = req.body;
    const dir = type === "input" ? INPUT_DIR : OUTPUT_DIR;
    try {
      const oldPath = path.join(dir, oldName);
      const newPath = path.join(dir, newName);
      if (await fs.pathExists(oldPath)) {
        await fs.rename(oldPath, newPath);
        res.json({ success: true });
      } else {
        res.status(404).json({ error: "File not found" });
      }
    } catch (error) {
      res.status(500).json({ error: "Failed to rename file" });
    }
  });

  app.get("/api/env-status", async (req, res) => {
    const status: any = {};
    try {
      await execPromise("cobc --version");
      status.cobol = { available: true, version: "GnuCOBOL" };
    } catch (e) {
      status.cobol = { available: false, error: "GnuCOBOL (cobc) not found. COBOL will run in simulation mode." };
    }

    try {
      await execPromise("gcc --version");
      status.c = { available: true, version: "GCC" };
    } catch (e) {
      status.c = { available: false, error: "GCC not found." };
    }

    try {
      await execPromise("python3 --version");
      status.python = { available: true, version: "Python 3" };
    } catch (e) {
      status.python = { available: false, error: "Python 3 not found." };
    }

    res.json(status);
  });

  app.post("/api/compile", async (req, res) => {
    const { code, language, name } = req.body;
    if (language !== 'cobol') {
      return res.status(400).json({ error: "Only COBOL compilation is supported" });
    }

    const tempFile = path.join(process.cwd(), `temp_${Date.now()}.cob`);
    const binFile = name ? `${name}.load` : `output_${Date.now()}.load`;
    
    try {
      await fs.writeFile(tempFile, code);
      
      // Try real compilation
      await execPromise("cobc --version");
      await execPromise(`cobc -x -o ${path.join(OUTPUT_DIR, binFile)} ${tempFile}`);
      res.json({ success: true, message: "Compilation successful", loadFile: binFile });
    } catch (error: any) {
      // Return error to frontend, which will handle simulation if needed
      res.status(500).json({ 
        error: error.message, 
        compilerMissing: error.message.includes('not found') || error.message.includes('ENOENT')
      });
    } finally {
      await fs.remove(tempFile);
    }
  });

  app.post("/api/run", async (req, res) => {
    const { code, language, inputFileNames, inputFilesContent, binaryName } = req.body;
    
    if (binaryName) {
      // Run an existing binary from the output repository
      try {
        const binPath = path.join(OUTPUT_DIR, binaryName);
        if (!(await fs.pathExists(binPath))) {
          return res.status(404).json({ error: "Binary file not found" });
        }

        // Copy binary to current directory
        const localBin = `run_${Date.now()}`;
        await fs.copy(binPath, path.join(process.cwd(), localBin));
        if (process.platform !== 'win32') {
          await execPromise(`chmod +x ${path.join(process.cwd(), localBin)}`);
        }

        // Copy input files
        if (inputFileNames && Array.isArray(inputFileNames)) {
          for (const name of inputFileNames) {
            const src = path.join(INPUT_DIR, name);
            if (await fs.pathExists(src)) {
              await fs.copy(src, path.join(process.cwd(), name));
            }
          }
        }
        if (inputFilesContent && Array.isArray(inputFilesContent)) {
          for (const file of inputFilesContent) {
            if (file && file.name && file.content) {
              await fs.writeFile(path.join(process.cwd(), file.name), file.content);
            }
          }
        }

        const initialFiles = new Set(await fs.readdir(process.cwd()));
        
        let stdout = "";
        let stderr = "";

        try {
          const content = await fs.readFile(path.join(process.cwd(), localBin), 'utf-8');
          if (content === "SIMULATED_COBOL_LOAD_MODULE") {
            // Return special error to frontend to trigger simulation
            return res.status(400).json({ error: "SIMULATED_LOAD_MODULE", message: "This is a simulated load module. Please run in simulation mode." });
          } else {
            const result = await execPromise(`./${localBin}`);
            stdout = result.stdout;
            stderr = result.stderr;
          }
        } catch (e: any) {
          stdout = e.stdout || "";
          stderr = e.stderr || e.message;
        }

        const mainOutputFileName = `output_${Date.now()}.txt`;
        await fs.writeFile(path.join(OUTPUT_DIR, mainOutputFileName), stdout);

        const finalFiles = await fs.readdir(process.cwd());
        const newFiles = finalFiles.filter(f => !initialFiles.has(f) && f !== localBin);
        
        for (const f of newFiles) {
          await fs.copy(path.join(process.cwd(), f), path.join(OUTPUT_DIR, f));
          await fs.remove(path.join(process.cwd(), f));
        }

        // Cleanup
        await fs.remove(path.join(process.cwd(), localBin));
        if (inputFileNames && Array.isArray(inputFileNames)) {
          for (const name of inputFileNames) {
            await fs.remove(path.join(process.cwd(), name));
          }
        }
        if (inputFilesContent && Array.isArray(inputFilesContent)) {
          for (const file of inputFilesContent) {
            await fs.remove(path.join(process.cwd(), file.name));
          }
        }

        res.json({ stdout, stderr, outputFileName: mainOutputFileName, newFiles });
      } catch (error: any) {
        res.status(500).json({ error: error.message });
      }
      return;
    }

    if (language === "python") {
      const tempFile = path.join(process.cwd(), `temp_${Date.now()}.py`);
      
      try {
        await fs.writeFile(tempFile, code);
        
        // Copy input files to current directory for the script to access
        if (inputFileNames && Array.isArray(inputFileNames)) {
          for (const name of inputFileNames) {
            const src = path.join(INPUT_DIR, name);
            if (await fs.pathExists(src)) {
              await fs.copy(src, path.join(process.cwd(), name));
            }
          }
        }

        // Write input files from content (Firestore)
        if (inputFilesContent && Array.isArray(inputFilesContent)) {
          for (const file of inputFilesContent) {
            if (file && file.name && file.content) {
              await fs.writeFile(path.join(process.cwd(), file.name), file.content);
            }
          }
        }

        // Capture initial files to identify new ones later
        const initialFiles = new Set(await fs.readdir(process.cwd()));

        const cmd = `python3 ${tempFile}`;
        const { stdout, stderr } = await execPromise(cmd);
        
        // Write STDOUT to output repository
        const mainOutputFileName = `output_${Date.now()}.txt`;
        await fs.writeFile(path.join(OUTPUT_DIR, mainOutputFileName), stdout);

        // Identify and copy new files created by the script
        const finalFiles = await fs.readdir(process.cwd());
        const newFiles = finalFiles.filter(f => !initialFiles.has(f) && f !== path.basename(tempFile));
        
        for (const f of newFiles) {
          await fs.copy(path.join(process.cwd(), f), path.join(OUTPUT_DIR, f));
          await fs.remove(path.join(process.cwd(), f));
        }

        // Cleanup copied input files
        if (inputFileNames && Array.isArray(inputFileNames)) {
          for (const name of inputFileNames) {
            await fs.remove(path.join(process.cwd(), name));
          }
        }
        if (inputFilesContent && Array.isArray(inputFilesContent)) {
          for (const file of inputFilesContent) {
            await fs.remove(path.join(process.cwd(), file.name));
          }
        }

        res.json({ stdout, stderr, outputFileName: mainOutputFileName, newFiles });
      } catch (error: any) {
        res.json({ stdout: error.stdout, stderr: error.stderr || error.message });
      } finally {
        await fs.remove(tempFile);
      }
    } else if (language === "cobol" || language === "java" || language === "c") {
      try {
        const ext = language === 'cobol' ? 'cob' : language === 'java' ? 'java' : 'c';
        const tempFile = path.join(process.cwd(), `temp_${Date.now()}.${ext}`);
        await fs.writeFile(tempFile, code);
        
        // Capture initial files
        const initialFiles = new Set(await fs.readdir(process.cwd()));

        // Copy input files to current directory for the script to access
        if (inputFileNames && Array.isArray(inputFileNames)) {
          for (const name of inputFileNames) {
            const src = path.join(INPUT_DIR, name);
            if (await fs.pathExists(src)) {
              await fs.copy(src, path.join(process.cwd(), name));
            }
          }
        }

        // Write input files from content (Firestore)
        if (inputFilesContent && Array.isArray(inputFilesContent)) {
          for (const file of inputFilesContent) {
            if (file && file.name && file.content) {
              await fs.writeFile(path.join(process.cwd(), file.name), file.content);
            }
          }
        }

        // Check if compiler is available
        if (language === 'cobol') {
          await execPromise("cobc --version");
          const binFile = `temp_${Date.now()}`;
          await execPromise(`cobc -x -o ${binFile} ${tempFile}`);
          const { stdout, stderr } = await execPromise(`./${binFile}`);
          
          const mainOutputFileName = `output_${Date.now()}.txt`;
          await fs.writeFile(path.join(OUTPUT_DIR, mainOutputFileName), stdout);
          
          const finalFiles = await fs.readdir(process.cwd());
          const newFiles = finalFiles.filter(f => !initialFiles.has(f) && f !== path.basename(tempFile) && f !== binFile);
          
          for (const f of newFiles) {
            await fs.copy(path.join(process.cwd(), f), path.join(OUTPUT_DIR, f));
            await fs.remove(path.join(process.cwd(), f));
          }

          res.json({ stdout, stderr, outputFileName: mainOutputFileName, newFiles });
          await fs.remove(path.join(process.cwd(), binFile));
        } else if (language === 'c') {
          await execPromise("gcc --version");
          const binFile = `temp_${Date.now()}`;
          await execPromise(`gcc -o ${binFile} ${tempFile}`);
          const { stdout, stderr } = await execPromise(`./${binFile}`);
          
          const mainOutputFileName = `output_${Date.now()}.txt`;
          await fs.writeFile(path.join(OUTPUT_DIR, mainOutputFileName), stdout);
          
          const finalFiles = await fs.readdir(process.cwd());
          const newFiles = finalFiles.filter(f => !initialFiles.has(f) && f !== path.basename(tempFile) && f !== binFile);
          
          for (const f of newFiles) {
            await fs.copy(path.join(process.cwd(), f), path.join(OUTPUT_DIR, f));
            await fs.remove(path.join(process.cwd(), f));
          }

          res.json({ stdout, stderr, outputFileName: mainOutputFileName, newFiles });
          await fs.remove(path.join(process.cwd(), binFile));
        } else {
          throw new Error("Compiler not available");
        }
      } catch (error: any) {
        res.status(500).json({ 
          error: error.message,
          compilerMissing: error.message.includes('not found') || error.message.includes('ENOENT')
        });
      } finally {
        // Cleanup
        const tempFiles = (await fs.readdir(process.cwd())).filter(f => f.startsWith('temp_'));
        for (const f of tempFiles) {
          await fs.remove(path.join(process.cwd(), f));
        }
        if (inputFileNames && Array.isArray(inputFileNames)) {
          for (const name of inputFileNames) {
            await fs.remove(path.join(process.cwd(), name));
          }
        }
        if (inputFilesContent && Array.isArray(inputFilesContent)) {
          for (const file of inputFilesContent) {
            await fs.remove(path.join(process.cwd(), file.name));
          }
        }
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
