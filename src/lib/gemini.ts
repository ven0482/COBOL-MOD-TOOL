import { GoogleGenAI, Type } from "@google/genai";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });

export async function convertCobolToPython(
  cobolCode: string,
  context?: string
) {
  const model = "gemini-3-flash-preview";
  
  const prompt = `
    Convert the following COBOL code to modern Python.
    Ensure the Python code is idiomatic, well-documented, and maintains the original logic.
    
    COBOL CODE:
    ${cobolCode}
    
    ${context ? `ADDITIONAL CONTEXT: ${context}` : ""}
    
    Return ONLY the Python code. Do not include any other text or markdown formatting.
  `;

  const response = await ai.models.generateContent({
    model,
    contents: prompt,
  });

  return response.text;
}

export async function explainCobolCode(
  cobolCode: string
) {
  const model = "gemini-3-flash-preview";
  
  const prompt = `
    Explain the following COBOL code in detail. 
    Break down the logic, identify key variables, and explain what each section does.
    
    COBOL CODE:
    ${cobolCode}
  `;

  const response = await ai.models.generateContent({
    model,
    contents: prompt,
  });

  return response.text;
}
