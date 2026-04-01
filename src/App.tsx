/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useEffect, useRef } from 'react';
import { 
  auth, 
  db, 
  googleProvider, 
  signInWithPopup, 
  signInWithRedirect,
  getRedirectResult,
  signOut, 
  onAuthStateChanged, 
  collection, 
  doc, 
  addDoc, 
  onSnapshot, 
  query, 
  where, 
  orderBy,
  updateDoc,
  deleteDoc,
  getDocs,
  type User,
  OperationType,
  handleFirestoreError
} from './firebase';
import { GoogleGenAI, Type } from "@google/genai";
import { themes } from './themes';
import { 
  Layout, 
  Plus, 
  Folder, 
  FileCode, 
  Play, 
  CheckCircle, 
  AlertCircle, 
  BarChart3, 
  FolderOpen,
  ArrowLeftRight, 
  LogOut, 
  ChevronRight, 
  ChevronLeft,
  ChevronDown,
  ChevronUp,
  Upload,
  Search,
  Settings,
  Cpu,
  Bell,
  HelpCircle,
  MoreVertical,
  Code2,
  Database,
  Save,
  Trash2,
  Edit,
  Edit3,
  FileEdit,
  Eye,
  Copy,
  ArrowRight,
  ArrowLeft,
  Check,
  X,
  Server,
  ScrollText,
  History,
  Clock,
  Tag,
  BookOpen,
  RefreshCw,
  Download,
  GripVertical,
  EyeOff,
  FileText,
  LayoutGrid,
  Maximize2,
  Minimize2
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { Toaster, toast } from 'sonner';
import ReactMarkdown from 'react-markdown';
import Editor from '@monaco-editor/react';
import axios from 'axios';
import { cn } from './lib/utils';

// --- Types ---
interface Project {
  id: string;
  name: string;
  description: string;
  targetLanguage: string;
  createdBy: string;
  createdAt: any;
}

interface SourceElement {
  id: string;
  projectId: string;
  name: string;
  content: string;
  convertedContent?: string;
  targetLanguage: string;
  status: 'Pending' | 'Processing' | 'Completed' | 'Failed';
  createdAt: any;
  folder?: string;
}

interface ConversionReport {
  id: string;
  elementId: string;
  totalLines: number;
  convertedLines: number;
  errors: string[];
  warnings: string[];
  unsupportedStatements: string[];
  programStatistics?: any;
}

interface Rule {
  id: string;
  elementId: string;
  projectId: string;
  name: string;
  description: string;
  category: string;
  logic: string;
  createdAt: any;
  version: number;
}

interface TabConfig {
  id: string;
  label: string;
  icon: any;
  color: string;
  visible: boolean;
}

interface RuleVersion {
  id: string;
  ruleId: string;
  version: number;
  description: string;
  logic: string;
  createdAt: any;
}

interface TestCase {
  id: string;
  elementId: string;
  name: string;
  description: string;
  type: 'Execution' | 'Comparison';
  inputData: string; // For Comparison, this is sourceFileId
  expectedOutput: string; // For Comparison, this is destinationFileId
  actualOutput?: string;
  status: 'Pending' | 'Passed' | 'Failed';
  logs?: string;
  createdAt: any;
}

// --- Helpers ---
const extractFileNames = (cobolCode: string) => {
  const fileNames: { input: string[], output: string[] } = { input: [], output: [] };
  
  // Map internal names to file names from SELECT statements
  const internalToFileMap = new Map<string, string>();
  const selectRegex = /SELECT\s+([\w-]+)\s+ASSIGN\s+(?:TO\s+)?['"]?([\w.-]+)['"]?/gi;
  let match;
  while ((match = selectRegex.exec(cobolCode)) !== null) {
    internalToFileMap.set(match[1].toLowerCase(), match[2]);
  }

  const lowerCode = cobolCode.toLowerCase();
  
  // Find OPEN statements and identify modes
  // This regex looks for OPEN followed by modes and file names
  const openRegex = /open\s+(input|output|extend|i-o)\s+([\w\s-]+)(?=\.|\s+open|\s+close|\s+read|\s+write|\s+perform|\s+stop)/gi;
  let openMatch;
  
  const seenInput = new Set<string>();
  const seenOutput = new Set<string>();

  while ((openMatch = openRegex.exec(lowerCode)) !== null) {
    const mode = openMatch[1];
    const filesPart = openMatch[2];
    
    // Split by whitespace to get individual internal file names
    const internalNames = filesPart.split(/\s+/).filter(n => n.length > 0 && n !== 'input' && n !== 'output' && n !== 'extend' && n !== 'i-o');
    
    for (const internalName of internalNames) {
      const fileName = internalToFileMap.get(internalName);
      if (!fileName) continue;

      if (mode === 'input') {
        if (!seenInput.has(fileName)) { fileNames.input.push(fileName); seenInput.add(fileName); }
      } else if (mode === 'output' || mode === 'extend') {
        if (!seenOutput.has(fileName)) { fileNames.output.push(fileName); seenOutput.add(fileName); }
      } else if (mode === 'i-o') {
        if (!seenInput.has(fileName)) { fileNames.input.push(fileName); seenInput.add(fileName); }
        if (!seenOutput.has(fileName)) { fileNames.output.push(fileName); seenOutput.add(fileName); }
      }
    }
  }

  // Fallback: if no OPEN statements were found, use the old logic for all SELECTs
  if (fileNames.input.length === 0 && fileNames.output.length === 0) {
    for (const [internalName, fileName] of internalToFileMap.entries()) {
      if (!seenInput.has(fileName)) { fileNames.input.push(fileName); seenInput.add(fileName); }
    }
  }
  
  return fileNames;
};

const createDefaultProgramStats = (programName: string, linesOfCode: number) => ({
  programName,
  sizeMetrics: {
    linesOfCode,
    commentLines: 0,
    blankLines: 0,
    sections: 0,
    paragraphs: 0,
    statements: 0
  },
  complexityMetrics: {
    cyclomaticComplexity: 0,
    riskLevel: "LOW",
    ifCount: 0,
    evaluateCount: 0,
    performCount: 0,
    nestedDepth: 0,
    gotoCount: 0,
    alterCount: 0
  },
  dataMetrics: {
    totalVariables: 0,
    groupItems: 0,
    elementaryItems: 0,
    picXCount: 0,
    pic9Count: 0,
    comp3Count: 0,
    redefinesCount: 0,
    occursCount: 0
  },
  fileMetrics: {
    inputFiles: 0,
    outputFiles: 0,
    readOperations: 0,
    writeOperations: 0,
    rewriteOperations: 0,
    fileTypes: []
  },
  databaseMetrics: {
    sqlStatements: 0,
    selectCount: 0,
    insertCount: 0,
    updateCount: 0,
    deleteCount: 0,
    cursorCount: 0
  },
  dependencyMetrics: {
    callCount: 0,
    calledPrograms: [],
    copybooksUsed: []
  },
  cicsMetrics: {
    cicsCommands: 0,
    mapsUsed: [],
    transactionIds: []
  },
  qualityMetrics: {
    deadCode: 0,
    unreachableCode: 0,
    duplicateLogic: 0,
    hardcodedValues: 0
  },
  conversionReadiness: {
    autoConversionPercent: 0,
    manualIntervention: "LOW",
    unsupportedConstructs: [],
    structuredCodePercent: 0
  },
  performanceIndicators: {
    loopCount: 0,
    nestedLoops: 0,
    fileIOOperations: 0,
    dbCalls: 0
  },
  securityIndicators: {
    hardcodedSensitiveData: false,
    sensitiveFieldsDetected: []
  },
  maintainability: {
    maintainabilityIndex: 0,
    avgParagraphLength: 0
  },
  summary: {
    overallRiskScore: 0,
    riskLevel: "LOW",
    keyIssues: [],
    recommendation: ""
  }
});

const normalizeProgramStats = (stats: any, programName: string, linesOfCode: number) => {
  const fallback = createDefaultProgramStats(programName, linesOfCode);
  const merged = {
    ...fallback,
    ...stats,
    programName: stats?.programName || programName,
    sizeMetrics: { ...fallback.sizeMetrics, ...(stats?.sizeMetrics || {}) },
    complexityMetrics: { ...fallback.complexityMetrics, ...(stats?.complexityMetrics || {}) },
    dataMetrics: { ...fallback.dataMetrics, ...(stats?.dataMetrics || {}) },
    fileMetrics: { ...fallback.fileMetrics, ...(stats?.fileMetrics || {}) },
    databaseMetrics: { ...fallback.databaseMetrics, ...(stats?.databaseMetrics || {}) },
    dependencyMetrics: { ...fallback.dependencyMetrics, ...(stats?.dependencyMetrics || {}) },
    cicsMetrics: { ...fallback.cicsMetrics, ...(stats?.cicsMetrics || {}) },
    qualityMetrics: { ...fallback.qualityMetrics, ...(stats?.qualityMetrics || {}) },
    conversionReadiness: { ...fallback.conversionReadiness, ...(stats?.conversionReadiness || {}) },
    performanceIndicators: { ...fallback.performanceIndicators, ...(stats?.performanceIndicators || {}) },
    securityIndicators: { ...fallback.securityIndicators, ...(stats?.securityIndicators || {}) },
    maintainability: { ...fallback.maintainability, ...(stats?.maintainability || {}) },
    summary: { ...fallback.summary, ...(stats?.summary || {}) }
  };

  const cc = Number(merged.complexityMetrics.cyclomaticComplexity || 0);
  if (!stats?.complexityMetrics?.riskLevel) {
    merged.complexityMetrics.riskLevel = cc > 20 ? "HIGH" : cc >= 10 ? "MEDIUM" : "LOW";
  }
  if (!stats?.summary?.riskLevel) {
    merged.summary.riskLevel = merged.complexityMetrics.riskLevel;
  }

  return merged;
};

const ByteRuler = ({ width = 80 }: { width?: number }) => {
  const markers = [];
  for (let i = 1; i <= width; i++) {
    if (i % 10 === 0) {
      markers.push(<span key={i} className="inline-block w-[1ch] text-blue-500 font-bold">{Math.floor(i / 10)}</span>);
    } else if (i % 5 === 0) {
      markers.push(<span key={i} className="inline-block w-[1ch] text-gray-400">|</span>);
    } else {
      markers.push(<span key={i} className="inline-block w-[1ch] text-gray-300">.</span>);
    }
  }
  
  const numbers = [];
  for (let i = 1; i <= width; i++) {
    if (i % 10 === 0) {
      numbers.push(<span key={i} className="inline-block w-[1ch] text-[8px] text-blue-400">0</span>);
    } else {
      numbers.push(<span key={i} className="inline-block w-[1ch] text-[8px] text-gray-300">{i % 10}</span>);
    }
  }

  return (
    <div className="font-mono text-[10px] select-none border-b bg-gray-50 py-1 px-4 overflow-hidden whitespace-nowrap">
      <div className="flex leading-none mb-1">{markers}</div>
      <div className="flex leading-none">{numbers}</div>
    </div>
  );
};

// --- Components ---

const IDERunner = ({ 
  firestoreInputFiles = [], 
  firestoreOutputFiles = [],
  activeElement = null,
  setActiveElement,
  elements = [],
  serverFiles,
  fetchFiles,
  handleDeleteServerFile,
  handleDeleteOutputFile
}: { 
  firestoreInputFiles?: any[], 
  firestoreOutputFiles?: any[],
  activeElement?: SourceElement | null,
  setActiveElement: (el: SourceElement | null) => void,
  elements?: SourceElement[],
  serverFiles: {inputs: string[], outputs: string[]},
  fetchFiles: () => Promise<void>,
  handleDeleteServerFile: (name: string, type: 'input' | 'output') => Promise<void>,
  handleDeleteOutputFile: (id: string, elementId: string) => Promise<void>
}) => {
  const [code, setCode] = useState('');
  const [language, setLanguage] = useState('python');
  const [selectedInputs, setSelectedInputs] = useState<string[]>([]);
  const [selectedOutputs, setSelectedOutputs] = useState<string[]>([]);
  const [output, setOutput] = useState('');
  const [isRunning, setIsRunning] = useState(false);
  const [isCompiling, setIsCompiling] = useState(false);
  const [isMaximized, setIsMaximized] = useState(false);
  const [isScanning, setIsScanning] = useState(false);
  const [showInputDropdown, setShowInputDropdown] = useState(false);
  const [showOutputDropdown, setShowOutputDropdown] = useState(false);
  const [isCheckingSyntax, setIsCheckingSyntax] = useState(false);
  const [syntaxErrors, setSyntaxErrors] = useState<{ line: number, message: string, severity: 'error' | 'warning' }[]>([]);
  const [envStatus, setEnvStatus] = useState<any>(null);

  useEffect(() => {
    const fetchEnvStatus = async () => {
      try {
        const res = await axios.get('/api/env-status');
        setEnvStatus(res.data);
      } catch (err) {
        console.error('Failed to fetch env status');
      }
    };
    fetchEnvStatus();
  }, []);

  useEffect(() => {
    if (activeElement) {
      if (language === 'cobol') {
        setCode(activeElement.content);
      } else if (activeElement.targetLanguage.toLowerCase() === language) {
        setCode(activeElement.convertedContent || '');
      }
    }
  }, [language, activeElement]);

  const handleLoadSource = (element: SourceElement) => {
    setCode(element.content);
    setLanguage('cobol');
    setActiveElement(element);
    toast.success('Source code loaded into IDE');
  };

  const handleLoadDestination = (element: SourceElement) => {
    if (element.convertedContent) {
      setCode(element.convertedContent);
      const target = element.targetLanguage.toLowerCase();
      if (target === 'python') setLanguage('python');
      else if (target === 'java') setLanguage('java');
      else if (target === 'c') setLanguage('c');
      else setLanguage('python'); // Default
      setActiveElement(element);
      toast.success('Destination code loaded into IDE');
    } else {
      toast.error('No destination code available');
    }
  };

  const handleFileSelect = (elementId: string) => {
    const element = elements.find(e => e.id === elementId);
    if (!element) return;
    
    if (language === 'cobol') {
      handleLoadSource(element);
    } else {
      handleLoadDestination(element);
    }
  };

  const filteredElements = elements.filter(e => {
    if (language === 'cobol') return true;
    return e.targetLanguage.toLowerCase() === language && e.convertedContent;
  });

  const handleScan = () => {
    setIsScanning(true);
    try {
      const detected: { input: string[], output: string[] } = { input: [], output: [] };
      
      const allAvailableInputs = [...serverFiles.inputs, ...firestoreInputFiles.map(f => f.name)];

      if (language === 'cobol') {
        const selectRegex = /SELECT\s+([\w-]+)\s+ASSIGN\s+(?:TO\s+)?['"]?([\w.-]+)['"]?/gi;
        let match;
        while ((match = selectRegex.exec(code)) !== null) {
          const fileName = match[2];
          if (allAvailableInputs.includes(fileName)) {
            detected.input.push(fileName);
          } else {
            detected.output.push(fileName);
          }
        }
      } else if (language === 'python' || language === 'java' || language === 'c') {
        const openRegex = /open\s*\(\s*['"]([\w.-]+)['"]\s*,\s*['"]([rwaxb+]+)['"]\s*\)/gi;
        const javaRegex = /new\s+File\s*\(\s*['"]([\w.-]+)['"]\s*\)/gi;
        let match;
        
        if (language === 'python') {
          while ((match = openRegex.exec(code)) !== null) {
            const fileName = match[1];
            const mode = match[2];
            if (mode.includes('r')) detected.input.push(fileName);
            else detected.output.push(fileName);
          }
        } else if (language === 'java') {
          while ((match = javaRegex.exec(code)) !== null) {
            const fileName = match[1];
            // We'll assume it's input if it exists in repo
            if (allAvailableInputs.includes(fileName)) detected.input.push(fileName);
            else detected.output.push(fileName);
          }
        }
      }

      setSelectedInputs(prev => Array.from(new Set([...prev, ...detected.input])));
      toast.success(`Detected ${detected.input.length} input files and ${detected.output.length} potential output files`);
    } catch (err) {
      toast.error('Failed to scan code');
    } finally {
      setIsScanning(false);
    }
  };

  const handleRun = async () => {
    setIsRunning(true);
    setOutput('Running...\n');
    try {
      // Check if a binary (.load) is selected in outputs
      const selectedBinary = selectedOutputs.find(f => f.endsWith('.load'));

      // Prepare file contents for Firestore files
      const inputFilesContent = selectedInputs
        .map(name => {
          const firestoreFile = firestoreInputFiles.find(f => f.name === name);
          return firestoreFile ? { name: firestoreFile.name, content: firestoreFile.content } : null;
        })
        .filter(f => f !== null);

      const res = await axios.post('/api/run', {
        code: selectedBinary ? undefined : code,
        language,
        binaryName: selectedBinary,
        inputFileNames: selectedInputs.filter(name => !firestoreInputFiles.some(f => f.name === name)),
        inputFilesContent
      });
      
      setOutput((res.data.stdout || '') + '\n' + (res.data.stderr || ''));
      
      if (res.data.outputFileName) {
        toast.success(`Execution complete. Main output: ${res.data.outputFileName}`);
        fetchFiles();
      }

      // Map and update existing Firestore output files if they match new files
      if (res.data.newFiles && Array.isArray(res.data.newFiles)) {
        for (const fileName of res.data.newFiles) {
          const matchingFirestoreFile = firestoreOutputFiles.find(f => f.name === fileName);
          if (matchingFirestoreFile) {
            try {
              const contentRes = await axios.get(`/api/files/content?name=${fileName}&type=output`);
              await updateDoc(doc(db, `projects/${activeElement!.projectId}/elements/${activeElement!.id}/outputFiles`, matchingFirestoreFile.id), {
                content: contentRes.data.content,
                type: language === 'cobol' ? 'Source' : 'Destination'
              });
              toast.success(`Mapped and updated ${fileName} in repository`);
            } catch (e) {
              console.error(`Failed to map ${fileName}:`, e);
            }
          }
        }
      }
    } catch (err: any) {
      if (err.response?.data?.compilerMissing || err.response?.data?.error === "SIMULATED_LOAD_MODULE") {
        setOutput(prev => prev + `\nCompiler missing or simulated module detected. Starting AI simulation...\n`);
        await handleSimulateRun(code, language, selectedOutputs.find(f => f.endsWith('.load')));
      } else {
        setOutput('Error: ' + (err.response?.data?.error || err.message));
      }
    } finally {
      setIsRunning(false);
    }
  };

  const handleSimulateCompile = async (codeToCompile: string) => {
    try {
      const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
      const prompt = `
        Act as a COBOL compiler. Analyze the following COBOL code and confirm if it has any syntax errors.
        If it's valid, simulate the creation of a "load" (executable) file.
        
        COBOL CODE:
        ${codeToCompile}
        
        Return ONLY a JSON object with:
        - "success": boolean
        - "errors": string[] (empty if success is true)
        - "message": string
      `;
      const response = await ai.models.generateContent({
        model: "gemini-3-flash-preview",
        contents: prompt,
        config: { responseMimeType: "application/json" }
      });
      
      let text = response.text;
      // Sanitize JSON response
      if (text.includes('```json')) {
        text = text.split('```json')[1].split('```')[0].trim();
      } else if (text.includes('```')) {
        text = text.split('```')[1].split('```')[0].trim();
      }

      const result = JSON.parse(text);
      if (result.success) {
        const binFile = `simulated_${Date.now()}.load`;
        await axios.post('/api/files/create', { 
          name: binFile, 
          content: "SIMULATED_COBOL_LOAD_MODULE", 
          type: 'output' 
        });
        
        setOutput(prev => prev + `\n[SIMULATION] Compilation successful.\nGenerated load module: ${binFile}\n`);
        fetchFiles();
        toast.success("Simulated compilation successful");
      } else {
        setOutput(prev => prev + `\n[SIMULATION] Compilation failed:\n${result.errors.join('\n')}\n`);
        toast.error("Simulated compilation failed");
      }
    } catch (error: any) {
      console.error("Simulation error:", error);
      setOutput(prev => prev + `\n[SIMULATION ERROR] ${error.message}\n`);
      toast.error("Simulation failed");
    }
  };

  const handleCheckSyntax = async () => {
    if (!code.trim()) return;
    setIsCheckingSyntax(true);
    setSyntaxErrors([]);
    try {
      const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
      const prompt = `
        Act as a code linter for ${language.toUpperCase()}. Analyze the following code for syntax errors.
        
        CODE:
        ${code}
        
        Return ONLY a JSON object with:
        - "errors": { "line": number, "message": string }[]
      `;
      const response = await ai.models.generateContent({
        model: "gemini-3-flash-preview",
        contents: prompt,
        config: { responseMimeType: "application/json" }
      });
      
      let text = response.text;
      if (text.includes('```json')) {
        text = text.split('```json')[1].split('```')[0].trim();
      } else if (text.includes('```')) {
        text = text.split('```')[1].split('```')[0].trim();
      }

      const result = JSON.parse(text);
      setSyntaxErrors(result.errors || []);
      if (result.errors && result.errors.length > 0) {
        toast.warning(`Found ${result.errors.length} syntax errors`);
      } else {
        toast.success("No syntax errors found");
      }
    } catch (error: any) {
      console.error("Syntax check error:", error);
    } finally {
      setIsCheckingSyntax(false);
    }
  };

  const handleSimulateRun = async (codeToRun: string, langToRun: string, binaryName?: string) => {
    try {
      const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
      
      let allInputContent = "";
      for (const name of selectedInputs) {
        try {
          const resp = await axios.get(`/api/files/content?name=${name}&type=input`);
          allInputContent += `\nFILE: ${name}\n${resp.data.content}\n`;
        } catch (e) {
          console.warn(`Could not fetch content for ${name}`);
        }
      }

      const prompt = binaryName 
        ? `
          Act as a COBOL runtime. You are running a pre-compiled binary named "${binaryName}".
          The original code was associated with this binary.
          Given the following input files, provide the expected STDOUT and any STDERR.
          Also, if the code writes to any files, simulate that and include the content of those files in the JSON response.
          
          INPUT FILES CONTENT:
          ${allInputContent}
          
          Return ONLY a JSON object with:
          - "stdout": string
          - "stderr": string
          - "files": { "filename": "content", ... }
        `
        : `
          Act as a ${langToRun.toUpperCase()} compiler and runtime.
          Given the following ${langToRun.toUpperCase()} code and input files content, provide the expected STDOUT and any STDERR.
          Also, if the code writes to any files, simulate that and include the content of those files in the JSON response.
          
          ${langToRun.toUpperCase()} CODE:
          ${codeToRun}
          
          INPUT FILES CONTENT:
          ${allInputContent}
          
          Return ONLY a JSON object with:
          - "stdout": string
          - "stderr": string
          - "files": { "filename": "content", ... }
        `;

      const response = await ai.models.generateContent({
        model: "gemini-3-flash-preview",
        contents: prompt,
        config: { responseMimeType: "application/json" }
      });
      
      const result = JSON.parse(response.text);
      
      if (result.files) {
        for (const [filename, content] of Object.entries(result.files)) {
          await axios.post('/api/files/create', { 
            name: filename, 
            content: content as string, 
            type: 'output' 
          });
        }
      }

      const mainOutputFileName = `sim_output_${Date.now()}.txt`;
      await axios.post('/api/files/create', { 
        name: mainOutputFileName, 
        content: result.stdout, 
        type: 'output' 
      });

      setOutput(prev => prev + `\n[SIMULATION STDOUT]\n${result.stdout}\n`);
      if (result.stderr) {
        setOutput(prev => prev + `\n[SIMULATION STDERR]\n${result.stderr}\n`);
      }
      
      fetchFiles();
      toast.success("Simulated execution complete");
    } catch (error: any) {
      console.error("Simulation error:", error);
      setOutput(prev => prev + `\n[SIMULATION ERROR] ${error.message}\n`);
      toast.error("Simulation failed");
    }
  };

  const handleCompile = async () => {
    if (language !== 'cobol') {
      toast.error('Compilation is only supported for COBOL');
      return;
    }
    setIsCompiling(true);
    setOutput('Compiling...\n');
    try {
      const res = await axios.post('/api/compile', {
        code,
        language,
        name: activeElement?.name || 'PROGRAM'
      });
      
      setOutput(`Compilation Result: ${res.data.message}\nLoad File Created: ${res.data.loadFile}`);
      toast.success('Compilation successful');
      fetchFiles();
    } catch (err: any) {
      if (err.response?.data?.compilerMissing) {
        setOutput(prev => prev + "\nCOBOL compiler (cobc) not found on server. Starting AI simulation...\n");
        await handleSimulateCompile(code);
      } else {
        const errorData = err.response?.data;
        if (errorData?.errors) {
          setOutput('Compilation Failed:\n' + errorData.errors.join('\n'));
        } else {
          setOutput('Error: ' + (errorData?.error || err.message));
        }
        toast.error('Compilation failed');
      }
    } finally {
      setIsCompiling(false);
    }
  };

  const allInputs = Array.from(new Set([...serverFiles.inputs, ...firestoreInputFiles.map(f => f.name)]));
  const allOutputs = Array.from(new Set([...serverFiles.outputs, ...firestoreOutputFiles.map(f => f.name)]));

  return (
    <div className={cn(
      "flex flex-col h-full bg-[#1e1e1e] text-white transition-all",
      isMaximized ? "fixed inset-0 z-[100] p-4" : "relative"
    )}>
      <div className="flex items-center justify-between p-2 bg-[#2d2d2d] border-b border-[#3e3e3e] rounded-t-lg">
        <div className="flex items-center gap-4 flex-wrap">
          {language === 'cobol' && envStatus?.cobol?.available === false && (
            <div className="flex items-center gap-1.5 px-2 py-0.5 bg-amber-900/30 border border-amber-700/50 rounded text-[10px] text-amber-400 animate-pulse">
              <AlertCircle className="w-3 h-3" />
              <span>Compiler Missing: Running in Simulation Mode</span>
            </div>
          )}
          <div className="flex items-center gap-2">
            <span className="text-[10px] font-bold text-gray-400 uppercase tracking-wider">Language:</span>
            <select 
              value={language} 
              onChange={(e) => setLanguage(e.target.value)}
              className="bg-[#3c3c3c] text-white text-xs rounded px-2 py-1 border border-[#4e4e4e] focus:ring-1 focus:ring-blue-500 outline-none"
            >
              {activeElement ? (
                <>
                  <option value="cobol">COBOL</option>
                  <option value={activeElement.targetLanguage.toLowerCase()}>{activeElement.targetLanguage}</option>
                  {activeElement.targetLanguage.toLowerCase() !== 'c' && <option value="c">C</option>}
                  {activeElement.targetLanguage.toLowerCase() !== 'python' && activeElement.targetLanguage.toLowerCase() !== 'cobol' && <option value="python">Python</option>}
                  {activeElement.targetLanguage.toLowerCase() !== 'java' && activeElement.targetLanguage.toLowerCase() !== 'cobol' && <option value="java">Java</option>}
                </>
              ) : (
                <>
                  <option value="python">Python</option>
                  <option value="cobol">COBOL</option>
                  <option value="java">Java</option>
                  <option value="c">C</option>
                </>
              )}
            </select>
          </div>

          <div className="flex items-center gap-2 border-l border-[#3e3e3e] pl-4">
            <span className="text-[10px] font-bold text-gray-400 uppercase tracking-wider">Active File:</span>
            <select 
              value={activeElement?.id || ''}
              onChange={(e) => handleFileSelect(e.target.value)}
              className="bg-[#3c3c3c] text-white text-xs rounded px-2 py-1 border border-[#4e4e4e] focus:ring-1 focus:ring-blue-500 outline-none min-w-[150px]"
            >
              <option value="">Select File...</option>
              {filteredElements.map(el => (
                <option key={el.id} value={el.id}>{el.name}</option>
              ))}
            </select>
          </div>
          
          {/* Input Files Dropdown */}
          <div className="relative border-l border-[#3e3e3e] pl-4">
            <button 
              onClick={() => {
                setShowInputDropdown(!showInputDropdown);
                setShowOutputDropdown(false);
              }}
              className="flex items-center gap-2 px-3 py-1 bg-[#3c3c3c] border border-[#4e4e4e] rounded text-xs hover:bg-[#4a4a4a] transition-colors"
            >
              <Folder className="w-3.5 h-3.5 text-blue-400" />
              <span>Inputs ({selectedInputs.length})</span>
              <ChevronDown className={cn("w-3 h-3 transition-transform", showInputDropdown && "rotate-180")} />
            </button>
            
            {showInputDropdown && (
              <div className="absolute top-full left-0 mt-1 w-64 bg-[#2d2d2d] border border-[#3e3e3e] rounded shadow-xl z-50 max-h-64 overflow-y-auto">
                <div className="p-2 border-b border-[#3e3e3e] flex items-center justify-between sticky top-0 bg-[#2d2d2d]">
                  <span className="text-[10px] font-bold text-gray-400 uppercase">Select Inputs</span>
                  <button onClick={() => setSelectedInputs([])} className="text-[10px] text-blue-400 hover:underline">Clear</button>
                </div>
                {allInputs.length > 0 ? (
                  allInputs.map(f => (
                    <label key={f} className="flex items-center gap-2 p-2 hover:bg-[#3e3e3e] cursor-pointer transition-colors">
                      <input 
                        type="checkbox" 
                        checked={selectedInputs.includes(f)}
                        onChange={() => {
                          setSelectedInputs(prev => 
                            prev.includes(f) ? prev.filter(i => i !== f) : [...prev, f]
                          );
                        }}
                        className="w-3.5 h-3.5 rounded border-gray-600 bg-gray-700 text-blue-600 focus:ring-0"
                      />
                      <span className="text-xs truncate flex-1">{f}</span>
                      {firestoreInputFiles.some(ff => ff.name === f) && (
                        <span className="text-[8px] bg-blue-900/50 text-blue-300 px-1 rounded">Repo</span>
                      )}
                    </label>
                  ))
                ) : (
                  <div className="p-4 text-center text-gray-500 text-xs italic">No files available</div>
                )}
              </div>
            )}
          </div>

          {/* Output Files Dropdown */}
          <div className="relative">
            <button 
              onClick={() => {
                setShowOutputDropdown(!showOutputDropdown);
                setShowInputDropdown(false);
              }}
              className="flex items-center gap-2 px-3 py-1 bg-[#3c3c3c] border border-[#4e4e4e] rounded text-xs hover:bg-[#4a4a4a] transition-colors"
            >
              <Database className="w-3.5 h-3.5 text-green-400" />
              <span>Outputs ({selectedOutputs.length})</span>
              <ChevronDown className={cn("w-3 h-3 transition-transform", showOutputDropdown && "rotate-180")} />
            </button>
            
            {showOutputDropdown && (
              <div className="absolute top-full left-0 mt-1 w-64 bg-[#2d2d2d] border border-[#3e3e3e] rounded shadow-xl z-50 max-h-64 overflow-y-auto">
                <div className="p-2 border-b border-[#3e3e3e] flex items-center justify-between sticky top-0 bg-[#2d2d2d]">
                  <span className="text-[10px] font-bold text-gray-400 uppercase">Select Outputs</span>
                  <button onClick={() => setSelectedOutputs([])} className="text-[10px] text-blue-400 hover:underline">Clear</button>
                </div>
                {allOutputs.length > 0 ? (
                  allOutputs.map(f => (
                    <label key={f} className="flex items-center gap-2 p-2 hover:bg-[#3e3e3e] cursor-pointer transition-colors">
                      <input 
                        type="checkbox" 
                        checked={selectedOutputs.includes(f)}
                        onChange={() => {
                          setSelectedOutputs(prev => 
                            prev.includes(f) ? prev.filter(i => i !== f) : [...prev, f]
                          );
                        }}
                        className="w-3.5 h-3.5 rounded border-gray-600 bg-gray-700 text-blue-600 focus:ring-0"
                      />
                      <span className="text-xs truncate flex-1">{f}</span>
                      {firestoreOutputFiles.some(ff => ff.name === f) && (
                        <span className="text-[8px] bg-green-900/50 text-green-300 px-1 rounded">Repo</span>
                      )}
                    </label>
                  ))
                ) : (
                  <div className="p-4 text-center text-gray-500 text-xs italic">No files available</div>
                )}
              </div>
            )}
          </div>

          <button 
            onClick={handleCheckSyntax}
            disabled={isCheckingSyntax || !code}
            className="flex items-center gap-1.5 px-3 py-1 bg-[#3c3c3c] hover:bg-[#4a4a4a] border border-[#4e4e4e] rounded text-xs font-medium transition-all"
            title="Check Syntax with AI"
          >
            {isCheckingSyntax ? <RefreshCw className="w-3.5 h-3.5 animate-spin text-amber-500" /> : <CheckCircle className="w-3.5 h-3.5 text-amber-500" />}
            Check Syntax
          </button>

          <button 
            onClick={handleScan}
            disabled={isScanning || !code}
            className="flex items-center gap-1.5 px-3 py-1 bg-[#3c3c3c] hover:bg-[#4a4a4a] border border-[#4e4e4e] rounded text-xs font-medium transition-all"
            title="Scan code for file declarations"
          >
            <Search className="w-3.5 h-3.5 text-yellow-500" />
            Scan Code
          </button>

          {language === 'cobol' && (
            <button 
              onClick={handleCompile} 
              disabled={isCompiling || !code}
              className="flex items-center gap-1.5 px-3 py-1 bg-amber-600 hover:bg-amber-700 rounded text-xs font-bold disabled:opacity-50 transition-all shadow-sm"
            >
              <Cpu className="w-3.5 h-3.5" />
              {isCompiling ? 'Compiling...' : 'Compile'}
            </button>
          )}

          <button 
            onClick={handleRun} 
            disabled={isRunning}
            className="flex items-center gap-1.5 px-4 py-1 bg-green-600 hover:bg-green-700 rounded text-xs font-bold disabled:opacity-50 transition-all shadow-sm"
          >
            <Play className="w-3.5 h-3.5" />
            {isRunning ? 'Running...' : 'Run Code'}
          </button>
        </div>
        <div className="flex items-center gap-2">
          <button 
            onClick={() => setIsMaximized(!isMaximized)}
            className="p-1.5 hover:bg-[#3e3e3e] rounded transition-colors"
            title={isMaximized ? "Minimize" : "Maximize"}
          >
            <Layout className="w-4 h-4" />
          </button>
        </div>
      </div>
      <div className="flex-1 flex overflow-hidden border-x border-b border-[#3e3e3e] rounded-b-lg">
        <div className="flex-1 border-r border-[#3e3e3e] relative group">
          <Editor
            height="100%"
            language={language === 'python' ? 'python' : (language === 'java' ? 'java' : (language === 'c' ? 'c' : 'cobol'))}
            theme="vs-dark"
            value={code}
            onChange={(v) => setCode(v || '')}
            options={{
              fontSize: 14,
              minimap: { enabled: false },
              scrollBeyondLastLine: false,
              automaticLayout: true,
              padding: { top: 10 },
              cursorBlinking: 'smooth',
              cursorSmoothCaretAnimation: 'on',
              smoothScrolling: true,
              renderLineHighlight: 'all'
            }}
          />
          {syntaxErrors.length > 0 && (
            <div className="absolute bottom-4 right-4 max-w-xs bg-[#1a1a1a]/90 border border-white/10 backdrop-blur-md rounded-lg p-3 shadow-2xl z-10 animate-in fade-in slide-in-from-bottom-2">
              <div className="flex items-center justify-between mb-2">
                <span className="text-[10px] font-bold uppercase tracking-widest flex items-center gap-2 text-red-400">
                  <AlertCircle className="w-3 h-3" /> Syntax Errors ({syntaxErrors.length})
                </span>
                <button onClick={() => setSyntaxErrors([])} className="text-gray-500 hover:text-white"><X className="w-3 h-3" /></button>
              </div>
              <div className="space-y-1 max-h-32 overflow-auto custom-scrollbar">
                {syntaxErrors.map((err, idx) => (
                  <div key={idx} className="text-[10px] text-red-200 py-1 border-b border-white/5 last:border-0">
                    <span className="font-bold mr-2">Line {err.line}:</span> {err.message}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
        <div className="w-1/3 flex flex-col bg-[#1a1a1a]">
          <div className="p-2 bg-[#2d2d2d]/50 text-[10px] font-bold uppercase tracking-wider text-gray-400 border-b border-white/10 flex items-center gap-2">
            <Code2 className="w-3 h-3" /> Terminal / Output
          </div>
          <pre className="flex-1 p-4 font-mono text-sm overflow-auto whitespace-pre-wrap text-green-400 bg-black/20">
            {output || 'Output will appear here after execution...'}
          </pre>
          <div className="p-2 bg-[#2d2d2d]/50 text-[10px] font-bold uppercase tracking-wider text-gray-400 border-t border-white/10 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Folder className="w-3 h-3" /> Output Repository
            </div>
            <div className="flex items-center gap-2">
              <button 
                onClick={fetchFiles}
                className="p-1 hover:bg-white/10 rounded transition-colors"
                title="Refresh files"
              >
                <ArrowLeftRight className="w-3 h-3" />
              </button>
              <span className="text-[8px] text-gray-500">Selected: {selectedOutputs.length}</span>
            </div>
          </div>
          <div className="h-48 overflow-y-auto p-2 bg-[#1a1a1a]/50">
            {allOutputs.length > 0 ? (
              <div className="space-y-1">
                {allOutputs.map(f => {
                  const isFirestore = firestoreOutputFiles.some(ff => ff.name === f);
                  const firestoreFile = firestoreOutputFiles.find(ff => ff.name === f);
                  
                  return (
                    <div 
                      key={f} 
                      className={cn(
                        "flex items-center gap-2 text-xs py-1.5 px-2 rounded cursor-pointer group transition-colors",
                        selectedOutputs.includes(f) ? "bg-blue-900/30 text-blue-300 border border-blue-800/50" : "hover:bg-[#2d2d2d] text-gray-300 border border-transparent"
                      )}
                      onClick={() => {
                        setSelectedOutputs(prev => 
                          prev.includes(f) ? prev.filter(i => i !== f) : [...prev, f]
                        );
                      }}
                    >
                      <div 
                        className="flex-1 flex items-center gap-2 overflow-hidden"
                        onClick={(e) => {
                          e.stopPropagation();
                          if (isFirestore && firestoreFile) {
                            setOutput(`--- Content of ${f} (Repository) ---\n\n${firestoreFile.content}`);
                          } else {
                            axios.get(`/api/files/content?name=${f}&type=output`).then(res => {
                              setOutput(`--- Content of ${f} ---\n\n${res.data.content}`);
                            }).catch(() => toast.error('Failed to read output file'));
                          }
                        }}
                      >
                        {f.endsWith('.load') ? (
                          <Cpu className="w-3.5 h-3.5 text-amber-400 shrink-0" />
                        ) : (
                          <FileCode className="w-3.5 h-3.5 text-blue-400 shrink-0" />
                        )}
                        <span className={cn("truncate", f.endsWith('.load') && "font-bold text-amber-200")}>{f}</span>
                        {isFirestore && (
                          <span className="text-[8px] bg-green-900/50 text-green-300 px-1 rounded shrink-0">Repo</span>
                        )}
                      </div>
                      <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
                        <button 
                          onClick={(e) => {
                            e.stopPropagation();
                            if (isFirestore && firestoreFile && activeElement) {
                              handleDeleteOutputFile(firestoreFile.id, activeElement.id);
                            } else {
                              handleDeleteServerFile(f, 'output');
                            }
                          }}
                          className="p-1 hover:text-red-400 transition-colors"
                        >
                          <Trash2 className="w-3 h-3" />
                        </button>
                      </div>
                      <input 
                        type="checkbox" 
                        checked={selectedOutputs.includes(f)}
                        onChange={() => {}} // Handled by parent div onClick
                        className="w-3 h-3 rounded border-gray-600 bg-gray-700 text-blue-600 focus:ring-0 focus:ring-offset-0 shrink-0"
                      />
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="h-full flex flex-col items-center justify-center text-gray-600 italic text-[10px] py-8">
                <Database className="w-8 h-8 mb-2 opacity-20" />
                No output files generated yet
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

const Navbar = ({ user, onSignOut, theme }: { user: User; onSignOut: () => void; theme: keyof typeof themes }) => (
  <nav className={cn("h-10 flex items-center justify-between px-4 border-b sticky top-0 z-50", themes[theme].sidebar, themes[theme].text, themes[theme].border)}>
    <div className="flex items-center gap-4">
      <div className="bg-indigo-600 p-1.5 rounded">
        <Database className="w-5 h-5 text-white" />
      </div>
      <span className="font-bold text-lg tracking-tight text-gray-100">COBOL Modernizer</span>
    </div>
    <div className="flex items-center gap-4">
      <div className="relative">
        <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-gray-600" />
        <input 
          type="text" 
          placeholder="Search projects..." 
          className="bg-[#1a1a1a] border border-white/5 rounded-full py-1.5 pl-9 pr-4 text-sm focus:ring-2 focus:ring-indigo-500 w-64 text-gray-200 placeholder-gray-600"
        />
      </div>
      <button className="p-2 hover:bg-white/5 rounded-full text-gray-500 hover:text-indigo-400 transition-colors"><Bell className="w-5 h-5" /></button>
      <button className="p-2 hover:bg-white/5 rounded-full text-gray-500 hover:text-indigo-400 transition-colors"><Settings className="w-5 h-5" /></button>
      <div className="flex items-center gap-3 ml-2 pl-4 border-l border-white/5">
        <div className="text-right hidden sm:block">
          <p className="text-xs font-bold text-gray-200">{user.displayName}</p>
          <p className="text-[10px] text-gray-600">Developer</p>
        </div>
        <img src={user.photoURL || ''} alt="avatar" className="w-8 h-8 rounded-full border border-indigo-500/50" />
        <button onClick={onSignOut} className="p-2 hover:bg-red-900/20 rounded-full text-red-400 transition-colors"><LogOut className="w-4 h-4" /></button>
      </div>
    </div>
  </nav>
);

const Sidebar = ({ theme, projects, activeProject, onSelectProject, onCreateProject, onDeleteProject, isCollapsed, onToggle }: any) => (
  <div className={cn(
    "border-r flex flex-col h-[calc(100vh-3.5rem)] transition-all duration-300 relative",
    themes[theme].sidebar, themes[theme].border,
    isCollapsed ? "w-12" : "w-64"
  )}>
    <div className={cn(
      "p-4 border-b flex items-center h-14",
      themes[theme].sidebar, themes[theme].border,
      isCollapsed ? "justify-center" : "justify-between"
    )}>
      {!isCollapsed && <h2 className="font-bold text-gray-400 uppercase text-xs tracking-wider">Projects</h2>}
      <button 
        onClick={onToggle}
        className="p-1 hover:bg-white/5 text-gray-600 rounded transition-colors"
        title={isCollapsed ? "Expand Projects" : "Collapse Projects"}
      >
        {isCollapsed ? <ChevronRight className="w-4 h-4" /> : <ChevronLeft className="w-4 h-4" />}
      </button>
    </div>
    {!isCollapsed && (
      <>
        <div className="p-4 border-b border-white/5 bg-[#121212] flex items-center justify-between">
          <span className="text-[10px] font-bold text-gray-600 uppercase tracking-widest">Action</span>
          <button 
            onClick={onCreateProject}
            className="p-1 hover:bg-white/5 text-indigo-400 rounded transition-colors"
          >
            <Plus className="w-4 h-4" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto py-2">
          {projects.map((p: Project) => (
            <div key={p.id} className="group relative">
              <button
                onClick={() => onSelectProject(p)}
                className={cn(
                  "w-full text-left px-4 py-3 flex items-center gap-3 transition-all",
                  activeProject?.id === p.id 
                    ? "bg-indigo-900/10 border-r-4 border-indigo-500 text-indigo-200" 
                    : "hover:bg-white/5 text-gray-500"
                )}
              >
                <Folder className={cn("w-4 h-4", activeProject?.id === p.id ? "text-indigo-400" : "text-gray-700")} />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold truncate">{p.name}</p>
                  <p className="text-[10px] opacity-50 truncate">{p.targetLanguage}</p>
                </div>
              </button>
              <button 
                onClick={(e) => {
                  e.stopPropagation();
                  onDeleteProject(p);
                }}
                className="absolute right-2 top-1/2 -translate-y-1/2 p-1.5 text-gray-600 hover:text-red-400 opacity-0 group-hover:opacity-100 transition-all"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>
          ))}
          {projects.length === 0 && (
            <div className="p-8 text-center text-gray-700">
              <p className="text-xs italic">No projects yet</p>
            </div>
          )}
        </div>
      </>
    )}
  </div>
);

const TabButton = ({ active, label, icon: Icon, onClick, color }: any) => (
  <button
    onClick={onClick}
    className={cn(
      "flex items-center gap-2 px-6 py-3 text-sm font-bold border-b-2 cursor-pointer",
      active 
        ? "border-indigo-500 text-indigo-300 bg-white/5" 
        : "border-transparent text-gray-500 hover:text-gray-300"
    )}
  >
    <Icon className={cn("w-4 h-4", active ? "text-indigo-400" : "text-gray-600")} />
    {label}
  </button>
);

export default function App() {
  const theme: keyof typeof themes = 'regular';
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [isSigningIn, setIsSigningIn] = useState(false);
  const [mousePos, setMousePos] = useState({ x: 0, y: 0 });

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      setMousePos({ x: e.clientX, y: e.clientY });
      document.documentElement.style.setProperty('--mouse-x', `${e.clientX}px`);
      document.documentElement.style.setProperty('--mouse-y', `${e.clientY}px`);
    };
    window.addEventListener('mousemove', handleMouseMove);
    return () => window.removeEventListener('mousemove', handleMouseMove);
  }, []);

  const [projects, setProjects] = useState<Project[]>([]);
  const [activeProject, setActiveProject] = useState<Project | null>(null);
  const [elements, setElements] = useState<SourceElement[]>([]);
  const [activeElement, setActiveElement] = useState<SourceElement | null>(null);
  const [activeTab, setActiveTab] = useState<'source' | 'destination' | 'input' | 'output' | 'report' | 'repository' | 'compare' | 'synthetic-data' | 'ide' | 'rules'>('source');
  const [reportSubTab, setReportSubTab] = useState<'summary' | 'kpi'>('summary');
  const [openKpiSections, setOpenKpiSections] = useState<string[]>([]);
  const [viewLanguage, setViewLanguage] = useState<string>('Java');
  const [sourceViewLanguage, setSourceViewLanguage] = useState<string>('COBOL');
  const [isCreatingProject, setIsCreatingProject] = useState(false);
  const [isAddingElement, setIsAddingElement] = useState(false);
  const [newProject, setNewProject] = useState({ name: '', description: '', targetLanguage: 'Java' });
  const [newElement, setNewElement] = useState({ name: '', content: '' });
  const [isModernizing, setIsModernizing] = useState(false);
  const [isListingRules, setIsListingRules] = useState(false);
  const [rules, setRules] = useState<Rule[]>([]);
  const [selectedRule, setSelectedRule] = useState<Rule | null>(null);
  const [ruleVersions, setRuleVersions] = useState<RuleVersion[]>([]);
  const [isGeneratingData, setIsGeneratingData] = useState(false);
  
  const [tabConfigs, setTabConfigs] = useState<TabConfig[]>([
    { id: 'source', label: 'Source Code', icon: FileCode, color: '#a78bfa', visible: true },
    { id: 'destination', label: 'Destination Code', icon: Code2, color: '#a78bfa', visible: true },
    { id: 'rules', label: 'Rules', icon: ScrollText, color: '#a78bfa', visible: true },
    { id: 'repository', label: 'Repository', icon: Database, color: '#a78bfa', visible: true },
    { id: 'ide', label: 'IDE', icon: Play, color: '#a78bfa', visible: true },
    { id: 'report', label: 'Report', icon: BarChart3, color: '#a78bfa', visible: true },
    { id: 'compare', label: 'Compare', icon: ArrowLeftRight, color: '#a78bfa', visible: true },
    { id: 'synthetic-data', label: 'Synthetic Data', icon: LayoutGrid, color: '#a78bfa', visible: true },
    { id: 'input', label: 'Input Files', icon: FolderOpen, color: '#4f46e5', visible: false },
    { id: 'output', label: 'Output Files', icon: CheckCircle, color: '#16a34a', visible: false },
  ]);

  const handleFileUpload = async (event: React.ChangeEvent<HTMLInputElement>, type: 'input' | 'output') => {
    const file = event.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = async (e) => {
      const content = e.target?.result;
      try {
        await axios.post('/api/files/create', {
          name: file.name,
          content: content as string,
          type
        });
        toast.success(`File ${file.name} uploaded successfully`);
        fetchFiles();
      } catch (error) {
        toast.error("Failed to upload file");
      }
    };
    reader.readAsText(file);
  };

  const [isEditingSource, setIsEditingSource] = useState(false);
  const [isEditingDestination, setIsEditingDestination] = useState(false);
  const [editedContent, setEditedContent] = useState('');
  const [syntheticData, setSyntheticData] = useState('');
  const [numRecords, setNumRecords] = useState(10);
  const [selectedSyntheticSourceId, setSelectedSyntheticSourceId] = useState<string>('');
  const [selectedSyntheticInputId, setSelectedSyntheticInputId] = useState<string>('');
  const [selectedInputFile, setSelectedInputFile] = useState<any | null>(null);
  const [report, setReport] = useState<ConversionReport | null>(null);
  const [inputFiles, setInputFiles] = useState<any[]>([]);
  const [outputFiles, setOutputFiles] = useState<any[]>([]);
  const [testCases, setTestCases] = useState<TestCase[]>([]);
  const [isGeneratingTest, setIsGeneratingTest] = useState(false);
  const [isRunningTest, setIsRunningTest] = useState<string | null>(null);
  const [projectToDelete, setProjectToDelete] = useState<Project | null>(null);
  const [elementToDelete, setElementToDelete] = useState<SourceElement | null>(null);
  const [isShowingFolderTree, setIsShowingFolderTree] = useState(false);
  const [selectedSourceFileId, setSelectedSourceFileId] = useState<string>('');
  const [selectedDestinationFileId, setSelectedDestinationFileId] = useState<string>('');
  const [selectedCompareElementId, setSelectedCompareElementId] = useState<string>('');
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(true);
  const [comparisonResult, setComparisonResult] = useState<{ 
    sourceLine: string, 
    destLine: string, 
    isMatch: boolean, 
    similarity: number,
    sourceIndex?: number | null,
    destIndex?: number | null
  }[] | null>(null);
  const [compareOptions, setCompareOptions] = useState({ 
    ignoreWhitespace: true, 
    ignoreCase: false,
    mode: 'full' as 'full' | 'position' | 'key',
    keyStart: 0,
    keyLength: 10
  });
  const [comparisonSummary, setComparisonSummary] = useState<{ 
    matches: number, 
    mismatches: number, 
    partials: number, 
    total: number,
    unmatchedDest?: number
  } | null>(null);
  const [selectedOutputFile, setSelectedOutputFile] = useState<any | null>(null);
  const [isEditingOutputFile, setIsEditingOutputFile] = useState(false);
  const [editingOutputFileContent, setEditingOutputFileContent] = useState('');
  const [serverFiles, setServerFiles] = useState<{inputs: string[], outputs: string[]}>({inputs: [], outputs: []});
  const [renamingFile, setRenamingFile] = useState<{id: string, name: string, type: 'input' | 'output' | 'server-input' | 'server-output', elementId?: string} | null>(null);
  const [newName, setNewName] = useState('');
  const [isCreatingFile, setIsCreatingFile] = useState<{ type: 'input' | 'output', elementId: string } | null>(null);
  const [editingFile, setEditingFile] = useState<{ id: string, name: string, content: string, type: 'input' | 'output' | 'server-input' | 'server-output', elementId?: string } | null>(null);
  const [newFileName, setNewFileName] = useState('');
  const [newFileContent, setNewFileContent] = useState('');
  const [collapsedElements, setCollapsedElements] = useState<string[]>([]);
  const [maximizedElements, setMaximizedElements] = useState<string[]>([]);
  const [isRepoMaximized, setIsRepoMaximized] = useState(false);
  const [repoSearchTerm, setRepoSearchTerm] = useState('');
  const [isServerRepoCollapsed, setIsServerRepoCollapsed] = useState(false);
  const [importingFile, setImportingFile] = useState<{name: string, type: 'input' | 'output'} | null>(null);
  const [syntaxErrors, setSyntaxErrors] = useState<{line: number, message: string}[]>([]);
  const [isCheckingSyntax, setIsCheckingSyntax] = useState(false);
  const [repositoryFolders, setRepositoryFolders] = useState<string[]>(['Default', 'Source', 'Load', 'Data']);
  const [selectedFolder, setSelectedFolder] = useState('Default');
  const [fileToFolderMap, setFileToFolderMap] = useState<Record<string, string>>({});

  const toggleElementCollapse = (elementId: string) => {
    setCollapsedElements(prev => 
      prev.includes(elementId) ? prev.filter(id => id !== elementId) : [...prev, elementId]
    );
  };

  const toggleElementMaximize = (elementId: string) => {
    setMaximizedElements(prev => 
      prev.includes(elementId) ? prev.filter(id => id !== elementId) : [...prev, elementId]
    );
  };

  const fetchFiles = async () => {
    try {
      const res = await axios.get('/api/files');
      setServerFiles(res.data);
    } catch (err) {
      console.error('Failed to fetch server files');
    }
  };

  useEffect(() => {
    fetchFiles();
  }, []);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (u) => {
      setUser(u);
      setLoading(false);
    });
    return unsubscribe;
  }, []);

  useEffect(() => {
    const handleRedirectResult = async () => {
      try {
        const result = await getRedirectResult(auth);
        if (result?.user) {
          toast.success('Successfully signed in');
        }
      } catch (err: any) {
        console.error('Redirect sign in error details:', err);
        toast.error(`Sign in failed (${err?.code || 'unknown'}): ${err?.message || 'Unknown error'}`);
      }
    };
    void handleRedirectResult();
  }, []);

  useEffect(() => {
    if (!user) return;
    const q = query(collection(db, 'projects'), where('createdBy', '==', user.uid));
    const unsubscribe = onSnapshot(q, (snapshot) => {
      const pList = snapshot.docs.map(d => ({ id: d.id, ...d.data() } as Project));
      setProjects(pList);
      
      // Update active project if not set or if current active project is gone
      if (pList.length > 0) {
        if (!activeProject || !pList.find(p => p.id === activeProject.id)) {
          setActiveProject(pList[0]);
          setViewLanguage(pList[0].targetLanguage);
        }
      } else {
        setActiveProject(null);
      }
    }, (err) => handleFirestoreError(err, OperationType.LIST, 'projects'));
    return unsubscribe;
  }, [user]);

  useEffect(() => {
    if (activeProject) {
      setViewLanguage(activeProject.targetLanguage);
    }
  }, [activeProject]);

  useEffect(() => {
    if (activeTab === 'destination' && activeElement && activeElement.targetLanguage.toLowerCase() !== viewLanguage.toLowerCase()) {
      const firstMatch = elements.find(el => el.convertedContent && el.targetLanguage.toLowerCase() === viewLanguage.toLowerCase());
      if (firstMatch) {
        setActiveElement(firstMatch);
      }
    }
  }, [viewLanguage, activeTab, elements]);

  useEffect(() => {
    if (activeTab === 'source' && activeElement && sourceViewLanguage !== 'COBOL' && activeElement.targetLanguage.toLowerCase() !== sourceViewLanguage.toLowerCase()) {
      const firstMatch = elements.find(el => el.convertedContent && el.targetLanguage.toLowerCase() === sourceViewLanguage.toLowerCase());
      if (firstMatch) {
        setActiveElement(firstMatch);
      }
    }
  }, [sourceViewLanguage, activeTab, elements]);

  useEffect(() => {
    if (!activeProject) {
      setElements([]);
      return;
    }
    const q = query(collection(db, `projects/${activeProject.id}/elements`));
    const unsubscribe = onSnapshot(q, (snapshot) => {
      const eList = snapshot.docs.map(d => ({ id: d.id, ...d.data() } as SourceElement));
      setElements(eList);
      
      // Update active element if not set or if current active element is gone
      if (eList.length > 0) {
        if (!activeElement || !eList.find(e => e.id === activeElement.id)) {
          setActiveElement(eList[0]);
        }
      } else {
        setActiveElement(null);
      }
    }, (err) => handleFirestoreError(err, OperationType.LIST, `projects/${activeProject.id}/elements`));
    return unsubscribe;
  }, [activeProject]);

  useEffect(() => {
    if (!activeElement || !activeProject) {
      setReport(null);
      return;
    }
    const q = query(collection(db, `projects/${activeProject.id}/elements/${activeElement.id}/reports`));
    const unsubscribe = onSnapshot(q, (snapshot) => {
      if (!snapshot.empty) {
        const reports = snapshot.docs.map(d => ({ id: d.id, ...d.data() } as ConversionReport & { createdAt?: string; updatedAt?: string }));
        reports.sort((a, b) => {
          const aHasStats = a.programStatistics ? 1 : 0;
          const bHasStats = b.programStatistics ? 1 : 0;
          if (aHasStats !== bHasStats) return bHasStats - aHasStats;
          const aTime = new Date(a.updatedAt || a.createdAt || 0).getTime();
          const bTime = new Date(b.updatedAt || b.createdAt || 0).getTime();
          return bTime - aTime;
        });
        setReport(reports[0] as ConversionReport);
      } else {
        setReport(null);
      }
    }, (err) => handleFirestoreError(err, OperationType.LIST, `projects/${activeProject.id}/elements/${activeElement.id}/reports`));
    return unsubscribe;
  }, [activeElement, activeProject]);

  useEffect(() => {
    if (!activeProject || elements.length === 0) {
      setInputFiles([]);
      return;
    }
    
    const unsubscribes: (() => void)[] = [];
    
    elements.forEach(element => {
      const q = query(collection(db, `projects/${activeProject.id}/elements/${element.id}/inputFiles`));
      const unsubscribe = onSnapshot(q, (snapshot) => {
        const files = snapshot.docs.map(d => ({ id: d.id, elementId: element.id, ...d.data() }));
        setInputFiles(prev => {
          const otherFiles = prev.filter(f => f.elementId !== element.id);
          return [...otherFiles, ...files];
        });
      }, (err) => handleFirestoreError(err, OperationType.LIST, `projects/${activeProject.id}/elements/${element.id}/inputFiles`));
      unsubscribes.push(unsubscribe);
    });
    
    return () => unsubscribes.forEach(unsub => unsub());
  }, [activeProject, elements]);

  useEffect(() => {
    if (!activeProject || elements.length === 0) {
      setOutputFiles([]);
      setComparisonResult(null);
      setSelectedSourceFileId('');
      setSelectedDestinationFileId('');
      return;
    }
    
    const unsubscribes: (() => void)[] = [];
    
    elements.forEach(element => {
      const q = query(collection(db, `projects/${activeProject.id}/elements/${element.id}/outputFiles`));
      const unsubscribe = onSnapshot(q, (snapshot) => {
        const files = snapshot.docs.map(d => ({ id: d.id, elementId: element.id, ...d.data() }));
        setOutputFiles(prev => {
          const otherFiles = prev.filter(f => f.elementId !== element.id);
          return [...otherFiles, ...files];
        });
      }, (err) => handleFirestoreError(err, OperationType.LIST, `projects/${activeProject.id}/elements/${element.id}/outputFiles`));
      unsubscribes.push(unsubscribe);
    });
    
    return () => unsubscribes.forEach(unsub => unsub());
  }, [activeProject, elements]);

  useEffect(() => {
    if (!activeElement || !activeProject) {
      setTestCases([]);
      return;
    }
    const q = query(collection(db, `projects/${activeProject.id}/elements/${activeElement.id}/testCases`));
    const unsubscribe = onSnapshot(q, (snapshot) => {
      setTestCases(snapshot.docs.map(d => ({ id: d.id, ...d.data() } as TestCase)));
    }, (err) => handleFirestoreError(err, OperationType.LIST, `projects/${activeProject.id}/elements/${activeElement.id}/testCases`));
    return unsubscribe;
  }, [activeElement, activeProject]);

  const handleSignIn = async () => {
    setIsSigningIn(true);
    try {
      console.log('Starting sign in with popup...');
      const result = await signInWithPopup(auth, googleProvider);
      console.log('Sign in successful:', result.user);
      toast.success('Successfully signed in');
    } catch (err: any) {
      console.error('Sign in error details:', err);
      const code = err?.code || 'unknown';
      const message = err?.message || 'Unknown error';
      let guidance = '';

      if (code === 'auth/unauthorized-domain') {
        guidance = `Authorize this domain in Firebase Console > Authentication > Settings > Authorized domains. Current host: ${window.location.hostname}`;
      } else if (code === 'auth/operation-not-allowed') {
        guidance = 'Enable Google sign-in in Firebase Console > Authentication > Sign-in method.';
      } else if (code === 'auth/popup-blocked' || code === 'auth/popup-closed-by-user' || code === 'auth/cancelled-popup-request') {
        guidance = 'Popup sign-in failed; falling back to redirect sign-in.';
        toast.error(guidance);
        await signInWithRedirect(auth, googleProvider);
        return;
      } else if (code === 'auth/network-request-failed') {
        guidance = 'Network issue detected. Check connectivity and retry.';
      }

      toast.error(`Sign in failed (${code}): ${message}`);
      if (guidance) {
        toast.error(guidance);
      }
    } finally {
      setIsSigningIn(false);
    }
  };

  const handleSignOut = async () => {
    await signOut(auth);
    setActiveProject(null);
    setActiveElement(null);
  };

  const handleCreateProject = async () => {
    if (!user || !newProject.name) return;
    try {
      const docRef = await addDoc(collection(db, 'projects'), {
        ...newProject,
        createdBy: user.uid,
        createdAt: new Date().toISOString()
      });
      setIsCreatingProject(false);
      setNewProject({ name: '', description: '', targetLanguage: 'Java' });
      toast.success('Project created');
    } catch (err) {
      handleFirestoreError(err, OperationType.CREATE, 'projects');
    }
  };

  const handleExportBRD = () => {
    if (!activeElement || rules.length === 0) {
      toast.error('No rules to export');
      return;
    }

    const categories = Array.from(new Set(rules.map(r => r.category)));
    
    let content = `# Business Requirements Document (BRD)\n\n`;
    content += `**Project:** ${activeProject?.name || 'N/A'}\n`;
    content += `**Program:** ${activeElement.name}\n`;
    content += `**Date:** ${new Date().toLocaleDateString()}\n\n`;
    content += `## 1. Executive Summary\n`;
    content += `This document outlines the business requirements and technical logic extracted from the legacy program ${activeElement.name}.\n\n`;
    
    content += `## 2. Business Rules Hierarchy\n\n`;
    
    categories.forEach((category, index) => {
      content += `### 2.${index + 1} ${category}\n`;
      const categoryRules = rules.filter(r => r.category === category);
      categoryRules.forEach((rule, rIndex) => {
        content += `#### 2.${index + 1}.${rIndex + 1} ${rule.name}\n`;
        content += `**Description:** ${rule.description}\n\n`;
        content += `**Technical Logic:**\n\`\`\`\n${rule.logic}\n\`\`\`\n\n`;
        content += `**Version History:**\n`;
        const versions = ruleVersions.filter(v => v.ruleId === rule.id).sort((a, b) => b.version - a.version);
        versions.forEach(v => {
          content += `- v${v.version} (${new Date(v.createdAt).toLocaleDateString()}): ${v.description}\n`;
        });
        content += `\n---\n\n`;
      });
    });

    content += `## 3. Version History\n`;
    content += `This document reflects the latest extracted rules (Version ${Math.max(...rules.map(r => r.version), 1)}).\n`;

    const blob = new Blob([content], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `BRD_${activeElement.name}.md`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    toast.success("BRD exported successfully.");
  };

  const moveTab = (id: string, direction: 'up' | 'down') => {
    const index = tabConfigs.findIndex(t => t.id === id);
    if (index === -1) return;
    if (direction === 'up' && index === 0) return;
    if (direction === 'down' && index === tabConfigs.length - 1) return;

    const newConfigs = [...tabConfigs];
    const targetIndex = direction === 'up' ? index - 1 : index + 1;
    [newConfigs[index], newConfigs[targetIndex]] = [newConfigs[targetIndex], newConfigs[index]];
    setTabConfigs(newConfigs);
  };

  const toggleTabVisibility = (id: string) => {
    setTabConfigs(prev => prev.map(t => t.id === id ? { ...t, visible: !t.visible } : t));
  };
  const handleAddElement = async () => {
    if (!activeProject || !newElement.name || !newElement.content) return;
    try {
      await addDoc(collection(db, `projects/${activeProject.id}/elements`), {
        ...newElement,
        projectId: activeProject.id,
        status: 'Pending',
        targetLanguage: activeProject.targetLanguage,
        createdAt: new Date().toISOString()
      });
      
      setIsAddingElement(false);
      setNewElement({ name: '', content: '' });
      toast.success('Source element added');
    } catch (err) {
      handleFirestoreError(err, OperationType.CREATE, `projects/${activeProject.id}/elements`);
    }
  };

  const handleElementUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!activeProject || !e.target.files) return;
    const files = Array.from(e.target.files);
    
    toast.info(`Uploading ${files.length} files...`);
    
    for (const file of files) {
      try {
        const content = await file.text();
        const docRef = await addDoc(collection(db, `projects/${activeProject.id}/elements`), {
          name: file.name,
          content: content,
          projectId: activeProject.id,
          status: 'Pending',
          targetLanguage: activeProject.targetLanguage,
          createdAt: new Date().toISOString()
        });

        await addDoc(collection(db, `projects/${activeProject.id}/elements/${docRef.id}/inputFiles`), {
          elementId: docRef.id,
          name: file.name,
          path: `/repository/${activeProject.name}/input/${file.name}/program.cbl`,
          content: content
        });
      } catch (err) {
        console.error(`Error uploading ${file.name}:`, err);
        toast.error(`Failed to upload ${file.name}`);
      }
    }
    toast.success('All files uploaded successfully');
    setIsAddingElement(false);
  };

  useEffect(() => {
    if (!activeProject || !activeElement) {
      setRules([]);
      return;
    }
    const q = query(collection(db, `projects/${activeProject.id}/elements/${activeElement.id}/rules`), orderBy('createdAt', 'desc'));
    const unsubscribe = onSnapshot(q, (snapshot) => {
      setRules(snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as Rule)));
    }, (err) => handleFirestoreError(err, OperationType.LIST, `projects/${activeProject.id}/elements/${activeElement.id}/rules`));
    return () => unsubscribe();
  }, [activeProject, activeElement]);

  useEffect(() => {
    if (!activeProject || !activeElement || !selectedRule) {
      setRuleVersions([]);
      return;
    }
    const q = query(collection(db, `projects/${activeProject.id}/elements/${activeElement.id}/rules/${selectedRule.id}/versions`), orderBy('version', 'desc'));
    const unsubscribe = onSnapshot(q, (snapshot) => {
      setRuleVersions(snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as RuleVersion)));
    }, (err) => handleFirestoreError(err, OperationType.LIST, `projects/${activeProject.id}/elements/${activeElement.id}/rules/${selectedRule.id}/versions`));
    return () => unsubscribe();
  }, [activeProject, activeElement, selectedRule]);

  const handleListRules = async () => {
    if (!activeElement || !activeProject) return;
    const projectId = activeProject.id;
    const elementId = activeElement.id;
    const elementContent = activeElement.content;

    setIsListingRules(true);
    try {
      const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
      
      const prompt = `
        You are an expert COBOL business rules analyst. 
        Analyze the following COBOL code and extract all business rules.
        
        For each rule, provide:
        1. Rule Name: A concise name for the rule.
        2. Description: A clear explanation of what the rule does.
        3. Category: The category of the rule (e.g., Validation, Calculation, Data Transformation, Flow Control).
        4. Logic: The technical logic behind the rule, referencing the COBOL code.
        
        COBOL Code:
        ${elementContent}
        
        Return the rules as a JSON array of objects with the following structure:
        [
          {
            "name": "string",
            "description": "string",
            "category": "string",
            "logic": "string"
          }
        ]
      `;

      const response = await ai.models.generateContent({
        model: "gemini-3.1-pro-preview",
        contents: prompt,
        config: {
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                name: { type: Type.STRING },
                description: { type: Type.STRING },
                category: { type: Type.STRING },
                logic: { type: Type.STRING }
              },
              required: ["name", "description", "category", "logic"]
            }
          }
        }
      });

      if (!response || !response.text) {
        throw new Error("Empty response from AI model");
      }

      const extractedRules = JSON.parse(response.text);

      for (const ruleData of extractedRules) {
        // Check if rule already exists for this element
        const rulesPath = `projects/${projectId}/elements/${elementId}/rules`;
        const q = query(collection(db, rulesPath), where('name', '==', ruleData.name));
        let snapshot;
        try {
          snapshot = await getDocs(q);
        } catch (err) {
          handleFirestoreError(err, OperationType.LIST, rulesPath);
          return;
        }
        
        if (snapshot.empty) {
          // Create new rule
          let docRef;
          try {
            docRef = await addDoc(collection(db, rulesPath), {
              ...ruleData,
              projectId,
              elementId,
              version: 1,
              createdAt: new Date().toISOString()
            });
          } catch (err) {
            handleFirestoreError(err, OperationType.CREATE, rulesPath);
            return;
          }
          
          // Create initial version
          const versionsPath = `${rulesPath}/${docRef.id}/versions`;
          try {
            await addDoc(collection(db, versionsPath), {
              ruleId: docRef.id,
              version: 1,
              description: ruleData.description,
              logic: ruleData.logic,
              createdAt: new Date().toISOString()
            });
          } catch (err) {
            handleFirestoreError(err, OperationType.CREATE, versionsPath);
            return;
          }
        } else {
          // Update existing rule and create new version
          const existingRule = snapshot.docs[0];
          const newVersion = (existingRule.data().version || 1) + 1;
          
          try {
            await updateDoc(doc(db, rulesPath, existingRule.id), {
              ...ruleData,
              version: newVersion,
              updatedAt: new Date().toISOString()
            });
          } catch (err) {
            handleFirestoreError(err, OperationType.UPDATE, `${rulesPath}/${existingRule.id}`);
            return;
          }
          
          const versionsPath = `${rulesPath}/${existingRule.id}/versions`;
          try {
            await addDoc(collection(db, versionsPath), {
              ruleId: existingRule.id,
              version: newVersion,
              description: ruleData.description,
              logic: ruleData.logic,
              createdAt: new Date().toISOString()
            });
          } catch (err) {
            handleFirestoreError(err, OperationType.CREATE, versionsPath);
            return;
          }
        }
      }

      toast.success('Rules extracted and documented successfully');
      setActiveTab('rules');
    } catch (err) {
      console.error('Error listing rules:', err);
      toast.error('Failed to extract rules');
    } finally {
      setIsListingRules(false);
    }
  };


  const handleModernize = async () => {
    if (!activeElement || !activeProject) return;
    const projectId = activeProject.id;
    const elementId = activeElement.id;
    const projectName = activeProject.name;
    const targetLanguage = activeProject.targetLanguage;
    const elementName = activeElement.name;
    const elementContent = activeElement.content;

    setIsModernizing(true);
    try {
      console.log('Starting modernization for:', elementName);
      
      const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
      
      const prompt = `
        You are an expert COBOL modernization architect. 
        Convert the following COBOL code into high-quality, production-ready ${targetLanguage} code.
        
        Requirements:
        1. Maintain business logic exactly.
        2. DO NOT include the original COBOL statements in the converted code.
        3. Add detailed inline comments at important code sections explaining the COBOL logic being modernized for better readability.
        4. If there are DB2 SQL statements, convert them to Oracle-compatible SQL.
        4. Use modern patterns for the target language (e.g., classes in Java/C#, functions/classes in Python).
        5. Handle COBOL divisions (IDENTIFICATION, ENVIRONMENT, DATA, PROCEDURE) appropriately.
        
        COBOL Code:
        ${elementContent}
        
        Return ONLY the converted code.
      `;

      const response = await ai.models.generateContent({
        model: "gemini-3.1-pro-preview",
        contents: prompt,
      });

      if (!response || !response.text) {
        throw new Error("Empty response from AI model");
      }

      const convertedCode = response.text;

      const lines = elementContent.split('\n').length;
      const programName = (elementName || 'UNKNOWN').split('.')[0];
      const statsPrompt = `
You are an expert COBOL analyzer and modernization assistant.

Analyze the given COBOL program and generate a detailed PROGRAM-LEVEL STATISTICS REPORT.

### INPUT:
${elementContent}

---

### OUTPUT FORMAT (STRICT JSON):

{
  "programName": "",
  "sizeMetrics": {
    "linesOfCode": 0,
    "commentLines": 0,
    "blankLines": 0,
    "sections": 0,
    "paragraphs": 0,
    "statements": 0
  },
  "complexityMetrics": {
    "cyclomaticComplexity": 0,
    "riskLevel": "LOW | MEDIUM | HIGH",
    "ifCount": 0,
    "evaluateCount": 0,
    "performCount": 0,
    "nestedDepth": 0,
    "gotoCount": 0,
    "alterCount": 0
  },
  "dataMetrics": {
    "totalVariables": 0,
    "groupItems": 0,
    "elementaryItems": 0,
    "picXCount": 0,
    "pic9Count": 0,
    "comp3Count": 0,
    "redefinesCount": 0,
    "occursCount": 0
  },
  "fileMetrics": {
    "inputFiles": 0,
    "outputFiles": 0,
    "readOperations": 0,
    "writeOperations": 0,
    "rewriteOperations": 0,
    "fileTypes": ["VSAM", "SEQUENTIAL"]
  },
  "databaseMetrics": {
    "sqlStatements": 0,
    "selectCount": 0,
    "insertCount": 0,
    "updateCount": 0,
    "deleteCount": 0,
    "cursorCount": 0
  },
  "dependencyMetrics": {
    "callCount": 0,
    "calledPrograms": [],
    "copybooksUsed": []
  },
  "cicsMetrics": {
    "cicsCommands": 0,
    "mapsUsed": [],
    "transactionIds": []
  },
  "qualityMetrics": {
    "deadCode": 0,
    "unreachableCode": 0,
    "duplicateLogic": 0,
    "hardcodedValues": 0
  },
  "conversionReadiness": {
    "autoConversionPercent": 0,
    "manualIntervention": "LOW | MEDIUM | HIGH",
    "unsupportedConstructs": [],
    "structuredCodePercent": 0
  },
  "performanceIndicators": {
    "loopCount": 0,
    "nestedLoops": 0,
    "fileIOOperations": 0,
    "dbCalls": 0
  },
  "securityIndicators": {
    "hardcodedSensitiveData": false,
    "sensitiveFieldsDetected": []
  },
  "maintainability": {
    "maintainabilityIndex": 0,
    "avgParagraphLength": 0
  },
  "summary": {
    "overallRiskScore": 0,
    "riskLevel": "LOW | MEDIUM | HIGH",
    "keyIssues": [],
    "recommendation": ""
  }
}

### RULES:
1. Always return valid JSON only (no explanation).
2. If a metric is not present, return 0 or empty array.
3. Detect COBOL-specific constructs like GO TO, PERFORM THRU, REDEFINES, OCCURS, EXEC SQL, EXEC CICS.
4. Estimate cyclomatic complexity based on decision points = IF + EVALUATE + loops + conditions.
5. Assign riskLevel: LOW (<10), MEDIUM (10-20), HIGH (>20).
6. Estimate autoConversionPercent based on structured code and unsupported constructs.
7. Provide realistic approximation if exact count is hard.
`;

      let programStatistics = createDefaultProgramStats(programName, lines);
      try {
        const statsResponse = await ai.models.generateContent({
          model: "gemini-3.1-pro-preview",
          contents: statsPrompt,
          config: { responseMimeType: "application/json" }
        });
        if (statsResponse?.text) {
          let statsText = statsResponse.text.trim();
          if (statsText.includes('```')) {
            statsText = statsText.replace(/```json/g, '').replace(/```/g, '').trim();
          }
          programStatistics = normalizeProgramStats(JSON.parse(statsText), programName, lines);
        }
      } catch (statsErr) {
        console.warn('Program statistics generation failed, using fallback metrics.', statsErr);
      }

      const reportData = {
        totalLines: lines,
        convertedLines: lines,
        errors: [],
        warnings: [],
        unsupportedStatements: programStatistics?.conversionReadiness?.unsupportedConstructs || [],
        programStatistics
      };

      // Update element with converted code
      await updateDoc(doc(db, `projects/${projectId}/elements`, elementId), {
        convertedContent: convertedCode,
        status: 'Completed'
      });

      // Save report
      await addDoc(collection(db, `projects/${projectId}/elements/${elementId}/reports`), {
        elementId: elementId,
        ...reportData,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      });

      // Create placeholders based on COBOL code (if any new ones found)
      const fileNames = extractFileNames(elementContent);
      
      // Handle Output Files first to ensure they are identified
      for (const name of fileNames.output) {
        // Create Source placeholder if it doesn't exist
        if (!outputFiles.find(f => f.name === name && f.type === 'Source')) {
          await addDoc(collection(db, `projects/${projectId}/elements/${elementId}/outputFiles`), {
            elementId: elementId,
            type: 'Source',
            name: name,
            path: `/repository/${projectName}/output/source/${elementName}/${name}`,
            content: '' // Placeholder
          });
        }
        // Create Destination placeholder if it doesn't exist
        if (!outputFiles.find(f => f.name === name && f.type === 'Destination')) {
          await addDoc(collection(db, `projects/${projectId}/elements/${elementId}/outputFiles`), {
            elementId: elementId,
            type: 'Destination',
            name: name,
            path: `/repository/${projectName}/output/destination/${elementName}/${name}`,
            content: '' // Placeholder
          });
        }
      }

      // Handle Input Files
      for (const name of fileNames.input) {
        if (!inputFiles.find(f => f.name === name)) {
          await addDoc(collection(db, `projects/${projectId}/elements/${elementId}/inputFiles`), {
            elementId: elementId,
            name: name,
            path: `/repository/${projectName}/input/${elementName}/${name}`,
            content: '' // Placeholder
          });
        }
      }

      // Cleanup: Move output files from inputFiles to outputFiles if they were incorrectly placed
      for (const inputFile of inputFiles) {
        // If it's identified as an output file but NOT an input file (strictly output)
        // or if it's an I-O file that the user wants to prioritize in output section
        const isOutput = fileNames.output.includes(inputFile.name);
        const isStrictlyOutput = isOutput && !fileNames.input.includes(inputFile.name);
        
        if (isStrictlyOutput) {
          console.log(`Moving strictly output file ${inputFile.name} to output section`);
          await deleteDoc(doc(db, `projects/${projectId}/elements/${elementId}/inputFiles`, inputFile.id));
        }
      }

      // Auto-create output file records
      await addDoc(collection(db, `projects/${projectId}/elements/${elementId}/outputFiles`), {
        elementId: elementId,
        type: 'Destination',
        name: `${elementName.split('.')[0]}.${targetLanguage === 'Java' ? 'java' : 'py'}`,
        path: `/repository/${projectName}/output/${elementName}/destination-output/`,
        content: convertedCode
      });

      // Also create a source reference in the output folder for comparison
      await addDoc(collection(db, `projects/${projectId}/elements/${elementId}/outputFiles`), {
        elementId: elementId,
        type: 'Source',
        name: `${elementName}`,
        path: `/repository/${projectName}/output/${elementName}/source-reference/`,
        content: elementContent
      });

      toast.success('Modernization complete');
      setActiveTab('destination');
    } catch (err: any) {
      console.error('Modernization error:', err);
      handleFirestoreError(err, OperationType.UPDATE, `projects/${projectId}/elements/${elementId}`);
      
      try {
        await updateDoc(doc(db, `projects/${projectId}/elements`, elementId), {
          status: 'Failed'
        });
      } catch (e) {
        console.error('Failed to update status to Failed:', e);
      }
    } finally {
      setIsModernizing(false);
    }
  };

  const handleGenerateSyntheticData = async () => {
    if (!activeProject) return;
    setIsGeneratingData(true);
    try {
      const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
      
      let sourceContent = "";
      let inputContent = "";
      
      if (selectedSyntheticSourceId) {
        const source = elements.find(e => e.id === selectedSyntheticSourceId);
        if (source) sourceContent = source.content;
      } else if (activeElement) {
        sourceContent = activeElement.content;
      }
      
      if (selectedSyntheticInputId) {
        const input = inputFiles.find(f => f.id === selectedSyntheticInputId);
        if (input) inputContent = input.content;
      }

      const prompt = `
        Analyze the following ${sourceContent ? 'COBOL code' : ''} ${inputContent ? 'and sample input data' : ''} to identify the record layout (FD - File Description, byte-offsets, data types).
        Then, generate ${numRecords} rows of synthetic test data that matches this structure exactly.
        The data should be in a plain text format as it would appear in a fixed-width flat file.
        
        ${sourceContent ? `COBOL Code:\n${sourceContent}` : ''}
        ${inputContent ? `Sample Input Data:\n${inputContent}` : ''}
        
        Return ONLY the synthetic data rows.
      `;

      const response = await ai.models.generateContent({
        model: "gemini-3.1-pro-preview",
        contents: prompt,
      });

      if (!response || !response.text) {
        throw new Error("Empty response from AI model");
      }

      setSyntheticData(response.text);
      toast.success('Synthetic data generated');
    } catch (err: any) {
      console.error('Data generation error:', err);
      toast.error(`Generation failed: ${err.message || 'Unknown error'}`);
    } finally {
      setIsGeneratingData(false);
    }
  };

  const handleLoadSyntheticInput = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!e.target.files || e.target.files.length === 0) return;
    const file = e.target.files[0];
    try {
      const content = await file.text();
      setSyntheticData(content);
      toast.success('Input file loaded');
    } catch (err) {
      console.error('File load error:', err);
      toast.error('Failed to load file');
    }
  };

  const handleSaveSyntheticData = async () => {
    if (!activeElement || !activeProject || !syntheticData) return;
    try {
      if (selectedInputFile) {
        // Update existing file
        await updateDoc(doc(db, `projects/${activeProject.id}/elements/${activeElement.id}/inputFiles`, selectedInputFile.id), {
          content: syntheticData
        });
        toast.success('File updated successfully');
      } else {
        // Create new file
        await addDoc(collection(db, `projects/${activeProject.id}/elements/${activeElement.id}/inputFiles`), {
          elementId: activeElement.id,
          name: 'synthetic_input.dat',
          path: `/repository/${activeProject.name}/input/${activeElement.name}/synthetic_input.dat`,
          content: syntheticData
        });
        toast.success('Synthetic data saved to repository');
      }
      setSelectedInputFile(null);
      setSyntheticData('');
      setActiveTab('input');
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, `projects/${activeProject.id}/elements/${activeElement.id}/inputFiles`);
    }
  };

  const handleMoveFile = async (file: any, fromType: 'input' | 'output', elementId: string) => {
    if (!activeProject) return;
    const toType = fromType === 'input' ? 'output' : 'input';
    const fromPath = `projects/${activeProject.id}/elements/${elementId}/${fromType}Files`;
    const toPath = `projects/${activeProject.id}/elements/${elementId}/${toType}Files`;

    try {
      // 1. Create in new collection
      const { id, ...fileData } = file;
      await addDoc(collection(db, toPath), {
        ...fileData,
        elementId: elementId,
        path: file.path ? file.path.replace(`/${fromType}/`, `/${toType}/`) : `/repository/${activeProject.name}/${toType}/${elementId}/${file.name}`,
        type: toType === 'output' ? 'Source' : undefined
      });

      // 2. Delete from old collection
      await deleteDoc(doc(db, fromPath, id));

      toast.success(`File moved to ${toType} section`);
    } catch (err) {
      console.error(`Error moving file from ${fromType} to ${toType}:`, err);
      handleFirestoreError(err, OperationType.WRITE, toPath);
    }
  };

  const handleDeleteInputFile = async (fileId: string, elementId: string) => {
    if (!activeProject) return;
    try {
      await deleteDoc(doc(db, `projects/${activeProject.id}/elements/${elementId}/inputFiles`, fileId));
      toast.success('File deleted');
    } catch (err) {
      handleFirestoreError(err, OperationType.DELETE, `projects/${activeProject.id}/elements/${elementId}/inputFiles`);
    }
  };

  const handleDeleteOutputFile = async (fileId: string, elementId: string) => {
    if (!activeProject) return;
    const file = outputFiles.find(f => f.id === fileId);
    try {
      await deleteDoc(doc(db, `projects/${activeProject.id}/elements/${elementId}/outputFiles`, fileId));
      
      // If it's a server file (we can try to delete it from server too)
      if (file && file.name) {
        try {
          await axios.delete(`/api/files?name=${file.name}&type=output`);
          fetchFiles(); // Refresh server files list
        } catch (e) {
          // Ignore if it wasn't on server
        }
      }

      toast.success('Output file deleted');
      if (selectedOutputFile?.id === fileId) {
        setSelectedOutputFile(null);
        setIsEditingOutputFile(false);
        setEditingOutputFileContent('');
      }
    } catch (err) {
      handleFirestoreError(err, OperationType.DELETE, `projects/${activeProject.id}/elements/${elementId}/outputFiles`);
    }
  };

  const handleDeleteServerFile = async (name: string, type: 'input' | 'output') => {
    try {
      await axios.delete(`/api/files?name=${name}&type=${type}`);
      fetchFiles();
      toast.success(`File ${name} deleted from server repository`);
    } catch (err) {
      toast.error(`Failed to delete ${name} from server`);
    }
  };

  const handleImportFromServer = async (fileName: string, type: 'input' | 'output', targetElementId: string, explicitType?: 'Source' | 'Destination') => {
    if (!activeProject) return;
    const targetElement = elements.find(e => e.id === targetElementId);
    if (!targetElement) return;

    try {
      const res = await axios.get(`/api/files/content?name=${fileName}&type=${type}`);
      const content = res.data.content;

      const collectionName = type === 'input' ? 'inputFiles' : 'outputFiles';
      const path = `/repository/${activeProject.name}/${type}/${targetElement.name}/${fileName}`;

      await addDoc(collection(db, `projects/${activeProject.id}/elements/${targetElementId}/${collectionName}`), {
        elementId: targetElementId,
        name: fileName,
        path: path,
        content: content,
        type: type === 'output' ? (explicitType || 'Destination') : undefined,
        createdAt: new Date().toISOString()
      });

      toast.success(`File ${fileName} imported to ${targetElement.name} ${type} section`);
    } catch (err) {
      console.error('Import error:', err);
      toast.error(`Failed to import ${fileName}`);
    }
  };

  const handleCopyOutputFile = async (file: any) => {
    if (!activeProject || !activeElement) return;
    try {
      await addDoc(collection(db, `projects/${activeProject.id}/elements/${activeElement.id}/outputFiles`), {
        elementId: activeElement.id,
        type: 'Destination',
        name: `modernized_${file.name}`,
        path: file.path.replace('/source/', '/destination/'),
        content: file.content,
        createdAt: new Date().toISOString()
      });
      toast.success('File copied to Destination Output');
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, `projects/${activeProject.id}/elements/${activeElement.id}/outputFiles`);
    }
  };

  const handleEditOutputFile = (file: any) => {
    setSelectedOutputFile(file);
    setEditingOutputFileContent(file.content || '');
    setIsEditingOutputFile(true);
  };

  const handleUpdateOutputFile = async () => {
    if (!activeProject || !activeElement || !selectedOutputFile) return;
    try {
      await updateDoc(doc(db, `projects/${activeProject.id}/elements/${activeElement.id}/outputFiles`, selectedOutputFile.id), {
        content: editingOutputFileContent
      });
      toast.success('Output file updated');
      setIsEditingOutputFile(false);
      setSelectedOutputFile(null);
      setEditingOutputFileContent('');
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, `projects/${activeProject.id}/elements/${activeElement.id}/outputFiles`);
    }
  };

  const handleMoveToOutput = async (file: any) => {
    if (!activeProject || !activeElement) return;
    try {
      // Add to outputFiles
      await addDoc(collection(db, `projects/${activeProject.id}/elements/${activeElement.id}/outputFiles`), {
        elementId: activeElement.id,
        type: 'Source',
        name: file.name,
        path: file.path.replace('/input/', '/output/'),
        content: file.content || ''
      });
      
      // Delete from inputFiles
      await deleteDoc(doc(db, `projects/${activeProject.id}/elements/${activeElement.id}/inputFiles`, file.id));
      
      toast.success(`Moved ${file.name} to Output Repository`);
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, `projects/${activeProject.id}/elements/${activeElement.id}/outputFiles`);
    }
  };

  const handleEditInputFile = (file: any) => {
    setSelectedInputFile(file);
    setSyntheticData(file.content || '');
    setActiveTab('synthetic-data');
  };

  const handleDeleteProject = async () => {
    if (!projectToDelete) return;
    try {
      // Note: In a real app, we'd also delete all elements and their subcollections
      // For this demo, we'll just delete the project doc
      await deleteDoc(doc(db, 'projects', projectToDelete.id));
      if (activeProject?.id === projectToDelete.id) {
        setActiveProject(null);
      }
      setProjectToDelete(null);
      toast.success('Project deleted');
    } catch (err) {
      handleFirestoreError(err, OperationType.DELETE, 'projects');
    }
  };

  const handleDeleteElement = async () => {
    if (!elementToDelete || !activeProject) return;
    try {
      const elementId = elementToDelete.id;
      const projectId = activeProject.id;

      // Delete subcollections first
      const subcollections = ['reports', 'inputFiles', 'outputFiles', 'testCases'];
      for (const sub of subcollections) {
        const q = query(collection(db, `projects/${projectId}/elements/${elementId}/${sub}`));
        const snapshot = await getDocs(q);
        for (const d of snapshot.docs) {
          await deleteDoc(doc(db, `projects/${projectId}/elements/${elementId}/${sub}`, d.id));
        }
      }

      // Delete the element itself
      await deleteDoc(doc(db, `projects/${projectId}/elements`, elementId));
      
      if (activeElement?.id === elementId) {
        setActiveElement(null);
      }
      setElementToDelete(null);
      toast.success('Source element and all related files deleted');
    } catch (err) {
      handleFirestoreError(err, OperationType.DELETE, `projects/${activeProject?.id}/elements`);
    }
  };

  const handleSaveSourceEdit = async () => {
    if (!activeElement || !activeProject) return;
    try {
      await updateDoc(doc(db, `projects/${activeProject.id}/elements`, activeElement.id), {
        content: editedContent
      });
      setIsEditingSource(false);
      toast.success('Source code updated');
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, `projects/${activeProject.id}/elements`);
    }
  };

  const handleRenameFile = async () => {
    if (!renamingFile || !newName) return;
    try {
      if (renamingFile.type === 'server-input' || renamingFile.type === 'server-output') {
        const type = renamingFile.type === 'server-input' ? 'input' : 'output';
        await axios.put('/api/files/rename', {
          oldName: renamingFile.name,
          newName: newName,
          type
        });
        fetchFiles();
      } else if (activeProject && renamingFile.elementId) {
        const collectionName = renamingFile.type === 'input' ? 'inputFiles' : 'outputFiles';
        await updateDoc(doc(db, `projects/${activeProject.id}/elements/${renamingFile.elementId}/${collectionName}`, renamingFile.id), {
          name: newName
        });
      }
      toast.success('File renamed');
      setRenamingFile(null);
      setNewName('');
    } catch (err) {
      toast.error('Failed to rename file');
    }
  };

  const handleCreateFile = async () => {
    if (!activeProject || !isCreatingFile || !newFileName) return;
    try {
      const collectionName = isCreatingFile.type === 'input' ? 'inputFiles' : 'outputFiles';
      await addDoc(collection(db, `projects/${activeProject.id}/elements/${isCreatingFile.elementId}/${collectionName}`), {
        elementId: isCreatingFile.elementId,
        name: newFileName,
        content: newFileContent,
        createdAt: new Date().toISOString()
      });
      toast.success('File created successfully');
      setIsCreatingFile(null);
      setNewFileName('');
      setNewFileContent('');
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, `projects/${activeProject.id}/elements/${isCreatingFile.elementId}`);
    }
  };

  const handleUpdateFileContent = async () => {
    if (!activeProject || !editingFile) return;
    try {
      if (editingFile.type === 'server-input' || editingFile.type === 'server-output') {
        const type = editingFile.type === 'server-input' ? 'input' : 'output';
        await axios.post('/api/files/create', {
          name: editingFile.name,
          content: editingFile.content,
          type
        });
        fetchFiles();
      } else if (editingFile.elementId) {
        const collectionName = editingFile.type === 'input' ? 'inputFiles' : 'outputFiles';
        await updateDoc(doc(db, `projects/${activeProject.id}/elements/${editingFile.elementId}/${collectionName}`, editingFile.id), {
          content: editingFile.content
        });
      }
      toast.success('File content updated');
      setEditingFile(null);
    } catch (err) {
      toast.error('Failed to update file content');
    }
  };

  const handleEditFile = async (file: any, type: 'input' | 'output' | 'server-input' | 'server-output', elementId?: string) => {
    if (type === 'server-input' || type === 'server-output') {
      try {
        const serverType = type === 'server-input' ? 'input' : 'output';
        const res = await axios.get(`/api/files/content?name=${file}&type=${serverType}`);
        setEditingFile({ id: file, name: file, content: res.data.content, type });
      } catch (err) {
        toast.error('Failed to fetch file content');
      }
    } else {
      setEditingFile({ ...file, type, elementId });
    }
  };

  const handleSaveDestinationEdit = async () => {
    if (!activeElement || !activeProject) return;
    try {
      await updateDoc(doc(db, `projects/${activeProject.id}/elements`, activeElement.id), {
        convertedContent: editedContent
      });
      setIsEditingDestination(false);
      toast.success('Destination code updated');
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, `projects/${activeProject.id}/elements`);
    }
  };

  const handleGenerateTestCase = async () => {
    if (!activeElement || !activeProject) return;
    const projectId = activeProject.id;
    const elementId = activeElement.id;
    const elementContent = activeElement.content;
    const convertedContent = activeElement.convertedContent;

    if (!convertedContent) {
      toast.error('Please convert the code first');
      return;
    }

    setIsGeneratingTest(true);
    try {
      const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
      
      const prompt = `
        You are a QA Engineer specializing in COBOL modernization.
        Based on the following COBOL source and its modernized ${activeProject.targetLanguage} version, generate a comprehensive test case.
        
        COBOL Source:
        ${elementContent}
        
        Modernized ${activeProject.targetLanguage}:
        ${convertedContent}
        
        Generate a test case in JSON format with the following fields:
        - name: A short name for the test case
        - description: What this test case verifies
        - inputData: Sample input data (matching the COBOL file structure if applicable)
        - expectedOutput: The expected output or behavior
        
        Return ONLY the JSON.
      `;

      const response = await ai.models.generateContent({
        model: "gemini-3.1-pro-preview",
        contents: prompt,
        config: { responseMimeType: "application/json" }
      });

      const testData = JSON.parse(response.text);
      
      await addDoc(collection(db, `projects/${projectId}/elements/${elementId}/testCases`), {
        elementId,
        ...testData,
        type: 'Execution',
        status: 'Pending',
        createdAt: new Date().toISOString()
      });

      toast.success('Test case generated');
    } catch (err) {
      console.error('Test generation error:', err);
      toast.error('Failed to generate test case');
    } finally {
      setIsGeneratingTest(false);
    }
  };

  const handleCreateComparisonTest = async () => {
    if (!activeElement || !activeProject) return;
    if (!selectedSourceFileId || !selectedDestinationFileId) {
      toast.error('Please select source and destination files in the Compare tab first');
      setActiveTab('compare');
      return;
    }

    const sourceFile = outputFiles.find(f => f.id === selectedSourceFileId);
    const destFile = outputFiles.find(f => f.id === selectedDestinationFileId);

    if (!sourceFile || !destFile) {
      toast.error('Selected files not found');
      return;
    }

    try {
      await addDoc(collection(db, `projects/${activeProject.id}/elements/${activeElement.id}/testCases`), {
        elementId: activeElement.id,
        name: `Compare: ${sourceFile.name} vs ${destFile.name}`,
        description: `100% match comparison between legacy COBOL output and modernized ${activeProject.targetLanguage} output.`,
        type: 'Comparison',
        inputData: selectedSourceFileId,
        expectedOutput: selectedDestinationFileId,
        status: 'Pending',
        createdAt: new Date().toISOString()
      });
      toast.success('Comparison test case added');
      setActiveTab('repository');
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, `projects/${activeProject.id}/elements/${activeElement.id}/testCases`);
    }
  };

  const handleRunTest = async (testCase: TestCase) => {
    if (!activeElement || !activeProject) return;
    const projectId = activeProject.id;
    const elementId = activeElement.id;
    const convertedContent = activeElement.convertedContent;

    setIsRunningTest(testCase.id);
    try {
      if (testCase.type === 'Comparison') {
        const sourceFile = outputFiles.find(f => f.id === testCase.inputData);
        const destFile = outputFiles.find(f => f.id === testCase.expectedOutput);

        if (!sourceFile || !destFile) {
          throw new Error('Comparison files not found');
        }

        const sContent = (sourceFile.content || '').trim();
        const dContent = (destFile.content || '').trim();

        // Use the same logic as the compare tool if needed, but here we want 100% match
        const isMatch = sContent === dContent;
        
        await updateDoc(doc(db, `projects/${projectId}/elements/${elementId}/testCases`, testCase.id), {
          actualOutput: dContent.substring(0, 1000) + (dContent.length > 1000 ? '...' : ''),
          status: isMatch ? 'Passed' : 'Failed',
          logs: isMatch ? 'Files match 100%' : 'Files do not match 100%'
        });

        if (isMatch) {
          toast.success(`Comparison test "${testCase.name}" passed!`);
        } else {
          toast.error(`Comparison test "${testCase.name}" failed.`);
        }
        return;
      }

      const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
      
      const prompt = `
        You are a code execution simulator. 
        Simulate the execution of the following ${activeProject.targetLanguage} code with the provided input data.
        
        Code:
        ${convertedContent}
        
        Input Data:
        ${testCase.inputData}
        
        Expected Output:
        ${testCase.expectedOutput}
        
        Determine if the execution matches the expected output.
        Return a JSON object with:
        - actualOutput: The simulated output of the execution
        - status: "Passed" if it matches expected behavior, "Failed" otherwise
        - logs: Any execution logs or error messages
        
        Return ONLY the JSON.
      `;

      const response = await ai.models.generateContent({
        model: "gemini-3.1-pro-preview",
        contents: prompt,
        config: { responseMimeType: "application/json" }
      });

      const result = JSON.parse(response.text);
      
      await updateDoc(doc(db, `projects/${projectId}/elements/${elementId}/testCases`, testCase.id), {
        actualOutput: result.actualOutput,
        status: result.status,
        logs: result.logs
      });

      if (result.status === 'Passed') {
        toast.success(`Test "${testCase.name}" passed!`);
      } else {
        toast.error(`Test "${testCase.name}" failed.`);
      }
    } catch (err) {
      console.error('Test execution error:', err);
      toast.error('Failed to run test');
    } finally {
      setIsRunningTest(null);
    }
  };

  const handleRunAllTests = async () => {
    if (testCases.length === 0) return;
    toast.info(`Running ${testCases.length} tests...`);
    for (const tc of testCases) {
      await handleRunTest(tc);
    }
    toast.success('All tests completed');
  };

  const handleClearTestResults = async () => {
    if (!activeProject || !activeElement || testCases.length === 0) return;
    const projectId = activeProject.id;
    const elementId = activeElement.id;
    
    try {
      const promises = testCases.map(tc => 
        updateDoc(doc(db, `projects/${projectId}/elements/${elementId}/testCases`, tc.id), {
          actualOutput: null,
          status: 'Pending',
          logs: null
        })
      );
      await Promise.all(promises);
      toast.success('Test results cleared');
    } catch (err) {
      console.error('Clear results error:', err);
      toast.error('Failed to clear results');
    }
  };

  const handleDeleteTestCase = async (testId: string) => {
    if (!activeProject || !activeElement) return;
    try {
      await deleteDoc(doc(db, `projects/${activeProject.id}/elements/${activeElement.id}/testCases`, testId));
      toast.success('Test case deleted');
    } catch (err) {
      handleFirestoreError(err, OperationType.DELETE, `projects/${activeProject.id}/elements/${activeElement.id}/testCases`);
    }
  };

  const getSimilarity = (s1: string, s2: string) => {
    if (s1 === s2) return 1;
    if (!s1 || !s2) return 0;
    
    const s1Norm = s1.trim();
    const s2Norm = s2.trim();
    if (s1Norm === s2Norm) return 0.99; // Almost exact if only whitespace differs

    // Sørensen–Dice coefficient using bigrams for robust fuzzy matching
    const getBigrams = (str: string) => {
      const bigrams = new Set<string>();
      for (let i = 0; i < str.length - 1; i++) {
        bigrams.add(str.substring(i, i + 2));
      }
      return bigrams;
    };

    const b1 = getBigrams(s1Norm);
    const b2 = getBigrams(s2Norm);
    
    if (b1.size === 0 || b2.size === 0) {
      // Fallback to simple character match if strings are too short for bigrams
      let matches = 0;
      const minLen = Math.min(s1Norm.length, s2Norm.length);
      for (let i = 0; i < minLen; i++) {
        if (s1Norm[i] === s2Norm[i]) matches++;
      }
      return matches / Math.max(s1Norm.length, s2Norm.length);
    }

    let intersect = 0;
    for (const bigram of b1) {
      if (b2.has(bigram)) intersect++;
    }

    return (2 * intersect) / (b1.size + b2.size);
  };

  const handleCompareFiles = () => {
    if (!selectedSourceFileId || !selectedDestinationFileId) {
      toast.error('Please select both source and destination files');
      return;
    }

    const sourceFile = [...inputFiles, ...outputFiles].find(f => f.id === selectedSourceFileId);
    const destFile = [...inputFiles, ...outputFiles].find(f => f.id === selectedDestinationFileId);

    if (!sourceFile || !destFile) {
      toast.error('Selected files not found');
      return;
    }

    const sourceLines = (sourceFile.content || '').split('\n');
    const destLines = (destFile.content || '').split('\n');
    
    const result: any[] = [];
    let matchCount = 0;
    let partialCount = 0;
    let mismatchCount = 0;

    const matchedDestIndices = new Set<number>();

    // Helper for preprocessing
    const preProcess = (line: string) => {
      let processed = line;
      if (compareOptions.ignoreWhitespace) processed = processed.trim();
      if (compareOptions.ignoreCase) processed = processed.toLowerCase();
      return processed;
    };

    // Pre-process all destination lines once
    const processedDestLines = destLines.map(line => preProcess(line));

    // One-to-all matching
    for (let i = 0; i < sourceLines.length; i++) {
      const sLine = sourceLines[i];
      const sProcessed = preProcess(sLine);
      
      let bestMatch = { index: -1, similarity: -1 };

      if (compareOptions.mode === 'position') {
        // Position mode: only compare at the same index
        if (i < processedDestLines.length) {
          const sim = getSimilarity(sProcessed, processedDestLines[i]);
          bestMatch = { index: i, similarity: sim };
        }
      } else if (compareOptions.mode === 'key') {
        // Key mode: compare specific substring
        const sKey = sLine.substring(compareOptions.keyStart, compareOptions.keyStart + compareOptions.keyLength);
        const sKeyProcessed = preProcess(sKey);

        for (let j = 0; j < destLines.length; j++) {
          const dKey = destLines[j].substring(compareOptions.keyStart, compareOptions.keyStart + compareOptions.keyLength);
          const dKeyProcessed = preProcess(dKey);
          
          if (sKeyProcessed === dKeyProcessed) {
            // If key matches, calculate full line similarity for display
            const sim = getSimilarity(sProcessed, processedDestLines[j]);
            if (sim > bestMatch.similarity) {
              bestMatch = { index: j, similarity: sim };
            }
            if (sim === 1) break;
          }
        }
      } else {
        // Full Record mode: search all
        // 1. Try same index first (optimization)
        if (i < processedDestLines.length) {
          const sim = getSimilarity(sProcessed, processedDestLines[i]);
          if (sim === 1) { // 100% match
            bestMatch = { index: i, similarity: sim };
          }
        }

        // 2. Search all if not a perfect match at same index
        if (bestMatch.similarity < 1) {
          for (let j = 0; j < processedDestLines.length; j++) {
            const sim = getSimilarity(sProcessed, processedDestLines[j]);
            if (sim === 1) { // 100% match
              bestMatch = { index: j, similarity: sim };
              break;
            }
          }
        }
        
        // 3. Fallback to fuzzy if no 100% match found and it's not strictly "100% match" requested
        // But the user asked for "if full record then 100% match", so we might want to skip fuzzy matching here
        // or at least keep it as a fallback with lower priority.
        if (bestMatch.similarity < 1) {
          for (let j = 0; j < processedDestLines.length; j++) {
            const sim = getSimilarity(sProcessed, processedDestLines[j]);
            if (sim > bestMatch.similarity) {
              bestMatch = { index: j, similarity: sim };
            }
          }
        }
      }

      const isExactMatch = bestMatch.similarity === 1;
      const isKeyMatch = compareOptions.mode === 'key' && bestMatch.index !== -1;
      
      if (isExactMatch || isKeyMatch || (compareOptions.mode === 'full' && bestMatch.similarity > 0.8) || (compareOptions.mode === 'position' && bestMatch.similarity > 0.5)) {
        if (isExactMatch) matchCount++;
        else partialCount++;

        result.push({
          sourceLine: sLine,
          destLine: destLines[bestMatch.index],
          isMatch: isExactMatch,
          similarity: bestMatch.similarity,
          sourceIndex: i + 1,
          destIndex: bestMatch.index + 1
        });
        matchedDestIndices.add(bestMatch.index);
      } else {
        mismatchCount++;
        result.push({
          sourceLine: sLine,
          destLine: '',
          isMatch: false,
          similarity: 0,
          sourceIndex: i + 1,
          destIndex: null
        });
      }
    }

    // Add unmatched destination lines at the end
    destLines.forEach((dLine, idx) => {
      if (!matchedDestIndices.has(idx)) {
        result.push({
          sourceLine: '',
          destLine: dLine,
          isMatch: false,
          similarity: 0,
          sourceIndex: null,
          destIndex: idx + 1
        });
      }
    });

    setComparisonResult(result);
    setComparisonSummary({
      matches: matchCount,
      partials: partialCount,
      mismatches: mismatchCount,
      total: sourceLines.length,
      unmatchedDest: destLines.length - matchedDestIndices.size
    });
    toast.success('Comparison complete with one-to-all matching');
  };

  if (loading) return <div className="h-screen flex items-center justify-center bg-gray-50"><Toaster position="top-right" /><div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600"></div></div>;

  if (!user) {
    return (
      <div className="h-screen flex flex-col items-center justify-center bg-[#001639] text-white p-4">
        <Toaster position="top-right" />
        <motion.div 
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="max-w-md w-full text-center space-y-8"
        >
          <div className="flex justify-center">
            <div className="bg-[#00a1e0] p-4 rounded-2xl shadow-2xl shadow-blue-500/20">
              <Database className="w-16 h-16 text-white" />
            </div>
          </div>
          <div className="space-y-2">
            <h1 className="text-4xl font-bold tracking-tight">COBOL Modernizer</h1>
            <p className="text-gray-400">Enterprise COBOL Modernization Platform</p>
          </div>
          <button 
            onClick={handleSignIn}
            disabled={isSigningIn}
            className="w-full bg-[#00a1e0] hover:bg-[#008bc2] disabled:opacity-70 disabled:cursor-not-allowed text-white font-bold py-4 px-8 rounded-xl transition-all flex items-center justify-center gap-3 shadow-lg"
          >
            <img src="https://www.google.com/favicon.ico" className="w-5 h-5" alt="google" />
            {isSigningIn ? 'Signing in...' : 'Sign in with Google'}
          </button>
          <div className="pt-8 border-t border-[#002b5c]">
            <p className="text-xs text-gray-500">Accelerate your legacy transformation with AI-powered code conversion and DB2 to Oracle SQL migration.</p>
          </div>
        </motion.div>
      </div>
    );
  }

  return (
    <div className={cn("h-screen flex flex-col overflow-hidden", themes[theme].main, themes[theme].text, themes[theme].border)}>
      <Toaster position="top-right" />
      <Navbar 
        user={user} 
        onSignOut={handleSignOut} 
        theme={theme}
      />
      
      <div className="flex flex-1 overflow-hidden">
        <Sidebar 
          theme={theme}
          projects={projects} 
          activeProject={activeProject} 
          onSelectProject={setActiveProject}
          onCreateProject={() => setIsCreatingProject(true)}
          onDeleteProject={setProjectToDelete}
          isCollapsed={isSidebarCollapsed}
          onToggle={() => setIsSidebarCollapsed(!isSidebarCollapsed)}
        />

        <main className={cn("flex-1 flex flex-col overflow-hidden", themes[theme].main)}>
          {activeProject ? (
            <>
              {/* Project Header */}
              <div className="bg-white border-b px-6 py-4 flex items-center justify-between shadow-sm">
                <div>
                  <div className="flex items-center gap-2 text-xs text-gray-500 mb-1">
                    <span>Projects</span>
                    <ChevronRight className="w-3 h-3" />
                    <span className="font-medium text-blue-600">{activeProject.name}</span>
                  </div>
                  <h1 
                    onClick={() => setIsShowingFolderTree(!isShowingFolderTree)}
                    className="text-xl font-bold text-gray-800 flex items-center gap-3 cursor-pointer hover:text-blue-600 transition-colors group"
                  >
                    {activeProject.name}
                    <Folder className="w-4 h-4 text-gray-400 group-hover:text-blue-500" />
                    <span className="text-xs font-normal bg-blue-100 text-blue-700 px-2 py-0.5 rounded-full">
                      {activeProject.targetLanguage}
                    </span>
                  </h1>
                </div>
                <div className="flex items-center gap-3">
                  {activeTab === 'source' && (
                    <>
                      <button 
                        onClick={handleListRules}
                        disabled={!activeElement || isListingRules}
                        className="flex items-center gap-2 px-4 py-2 bg-amber-500 text-white rounded-md text-sm font-bold hover:bg-amber-600 disabled:opacity-50 transition-all shadow-md"
                      >
                        {isListingRules ? <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white"></div> : <ScrollText className="w-4 h-4" />}
                        List Rules
                      </button>
                      <button 
                        onClick={handleModernize}
                        disabled={!activeElement || isModernizing}
                        className="flex items-center gap-2 px-4 py-2 bg-[#00a1e0] text-white rounded-md text-sm font-bold hover:bg-[#008bc2] disabled:opacity-50 transition-all shadow-md"
                      >
                        {isModernizing ? <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white"></div> : <Play className="w-4 h-4" />}
                        Convert Code
                      </button>
                    </>
                  )}
                </div>
              </div>

              {isShowingFolderTree && (
                <div className="bg-gray-100 border-b px-6 py-3 flex items-center gap-4 overflow-x-auto scrollbar-hide animate-in slide-in-from-top duration-200">
                  <div className="flex items-center gap-2 text-xs font-mono text-gray-600 bg-white px-3 py-1.5 rounded-lg border shadow-sm">
                    <Folder className="w-3.5 h-3.5 text-blue-500" />
                    <span>/repository/{activeProject.name}/</span>
                  </div>
                  <div className="flex items-center gap-2">
                    {[
                      { name: 'source', tab: 'source' },
                      { name: 'output', tab: 'output' },
                      { name: 'input', tab: 'input' },
                      { name: 'reports', tab: 'report' },
                      { name: 'repository', tab: 'repository' }
                    ].map(dir => (
                      <button 
                        key={dir.name}
                        onClick={() => {
                          setActiveTab(dir.tab as any);
                          setIsShowingFolderTree(false);
                        }}
                        className="flex items-center gap-1.5 px-3 py-1.5 bg-white border rounded-lg text-[10px] font-bold text-gray-600 hover:border-blue-400 hover:text-blue-600 transition-all shadow-sm"
                      >
                        <Folder className="w-3 h-3" />
                        {dir.name.toUpperCase()}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* Tabs */}
              <div className="bg-gray-50 border-b flex items-center px-6 overflow-x-auto scrollbar-hide shrink-0 gap-2">
                {tabConfigs.filter(t => t.visible).map((tab) => (
                  <TabButton 
                    key={tab.id}
                    active={activeTab === tab.id} 
                    label={tab.label} 
                    icon={tab.icon} 
                    color={tab.color}
                    onClick={() => setActiveTab(tab.id as any)} 
                  />
                ))}
              </div>

              {/* Content Area */}
              <div className="flex-1 flex overflow-hidden">
                {/* Main Editor/Viewer */}
                <div className="flex-1 bg-white overflow-hidden flex flex-col">
                  {activeTab === 'ide' ? (
                    <div className="flex-1 overflow-hidden">
                      <IDERunner 
                        firestoreInputFiles={inputFiles.filter(f => f.elementId === activeElement?.id)} 
                        firestoreOutputFiles={outputFiles.filter(f => f.elementId === activeElement?.id)} 
                        activeElement={activeElement}
                        setActiveElement={setActiveElement}
                        elements={elements}
                        serverFiles={serverFiles}
                        fetchFiles={fetchFiles}
                        handleDeleteServerFile={handleDeleteServerFile}
                        handleDeleteOutputFile={handleDeleteOutputFile}
                      />
                    </div>
                  ) : activeTab === 'rules' ? (
                    <div className="flex-1 overflow-auto p-6 font-mono text-sm">
                      <div className="space-y-6 h-full flex flex-col overflow-hidden">
                        <div className="flex items-center justify-between">
                          <div>
                            <h3 className="text-lg font-bold flex items-center gap-2">
                              <ScrollText className="w-5 h-5 text-amber-600" />
                              Business Rules Documentation
                            </h3>
                            <p className="text-xs text-gray-500">Documented business logic extracted from {activeElement?.name}.</p>
                          </div>
                          <div className="flex items-center gap-2">
                            <button 
                              onClick={handleExportBRD}
                              className="flex items-center gap-2 px-3 py-1.5 bg-blue-50 text-blue-700 rounded text-xs font-bold hover:bg-blue-100 border border-blue-200"
                            >
                              <Download className="w-3.5 h-3.5" />
                              Export BRD
                            </button>
                            <button 
                              onClick={handleListRules}
                              disabled={isListingRules}
                              className="flex items-center gap-2 px-3 py-1.5 bg-amber-50 text-amber-700 rounded text-xs font-bold hover:bg-amber-100 border border-amber-200"
                            >
                              {isListingRules ? <RefreshCw className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
                              Refresh Rules
                            </button>
                          </div>
                        </div>

                        <div className="flex-1 flex gap-6 overflow-hidden">
                          {/* Rules Hierarchy List */}
                          <div className="w-1/3 flex flex-col gap-4 overflow-auto pr-2">
                            {rules.length > 0 ? (
                              Array.from(new Set(rules.map(r => r.category))).map(category => (
                                <div key={category} className="space-y-2">
                                  <div className="flex items-center gap-2 px-2 py-1 bg-gray-100 rounded text-[10px] font-bold text-gray-500 uppercase tracking-widest">
                                    <Tag className="w-3 h-3" />
                                    {category}
                                  </div>
                                  <div className="space-y-2 pl-2">
                                    {rules.filter(r => r.category === category).map(rule => (
                                      <button
                                        key={rule.id}
                                        onClick={() => setSelectedRule(rule)}
                                        className={cn(
                                          "w-full text-left p-3 rounded-lg border transition-all group",
                                          selectedRule?.id === rule.id 
                                            ? "bg-amber-50 border-amber-200 shadow-sm" 
                                            : "bg-white border-gray-100 hover:border-amber-100 hover:bg-amber-50/30"
                                        )}
                                      >
                                        <div className="flex items-center justify-between mb-1">
                                          <h4 className="text-xs font-bold text-gray-800 group-hover:text-amber-700 truncate">{rule.name}</h4>
                                          <span className="text-[9px] font-mono text-gray-400">v{rule.version}</span>
                                        </div>
                                        <p className="text-[10px] text-gray-500 line-clamp-1">{rule.description}</p>
                                      </button>
                                    ))}
                                  </div>
                                </div>
                              ))
                            ) : (
                              <div className="h-full flex flex-col items-center justify-center text-gray-400 border-2 border-dashed rounded-xl p-8">
                                <ScrollText className="w-12 h-12 mb-2 opacity-10" />
                                <p className="text-sm">No rules documented yet.</p>
                                <button 
                                  onClick={handleListRules}
                                  className="mt-4 text-amber-600 font-bold text-xs hover:underline"
                                >
                                  Extract Rules Now
                                </button>
                              </div>
                            )}
                          </div>

                          {/* Rule Detail */}
                          <div className="flex-1 bg-gray-50 rounded-xl border border-gray-100 overflow-hidden flex flex-col">
                            {selectedRule ? (
                              <div className="flex flex-col h-full">
                                <div className="bg-white p-6 border-b">
                                  <div className="flex items-center justify-between mb-4">
                                    <div className="flex items-center gap-3">
                                      <div className="p-2 bg-amber-100 text-amber-600 rounded-lg">
                                        <BookOpen className="w-5 h-5" />
                                      </div>
                                      <div>
                                        <h3 className="text-lg font-bold text-gray-900">{selectedRule.name}</h3>
                                        <div className="flex items-center gap-3 mt-1">
                                          <span className="flex items-center gap-1 text-[10px] font-bold text-amber-600 bg-amber-50 px-2 py-0.5 rounded-full uppercase tracking-wider">
                                            <Tag className="w-2.5 h-2.5" />
                                            {selectedRule.category}
                                          </span>
                                          <span className="flex items-center gap-1 text-[10px] font-mono text-gray-400">
                                            <History className="w-2.5 h-2.5" />
                                            Version {selectedRule.version}
                                          </span>
                                          <span className="flex items-center gap-1 text-[10px] font-mono text-gray-400">
                                            <Clock className="w-2.5 h-2.5" />
                                            {new Date(selectedRule.createdAt).toLocaleDateString()}
                                          </span>
                                        </div>
                                      </div>
                                    </div>
                                  </div>
                                  <p className="text-sm text-gray-600 leading-relaxed">{selectedRule.description}</p>
                                </div>

                                <div className="flex-1 overflow-auto p-6 space-y-6">
                                  <section>
                                    <h4 className="text-xs font-bold text-gray-400 uppercase tracking-widest mb-3 flex items-center gap-2">
                                      <Code2 className="w-3.5 h-3.5" />
                                      Technical Logic
                                    </h4>
                                    <div className="bg-gray-900 text-gray-100 p-4 rounded-lg font-mono text-xs leading-relaxed overflow-x-auto">
                                      <ReactMarkdown>{selectedRule.logic}</ReactMarkdown>
                                    </div>
                                  </section>

                                  <section>
                                    <h4 className="text-xs font-bold text-gray-400 uppercase tracking-widest mb-3 flex items-center gap-2">
                                      <History className="w-3.5 h-3.5" />
                                      Version History
                                    </h4>
                                    <div className="space-y-3">
                                      {ruleVersions.filter(v => v.ruleId === selectedRule.id).sort((a, b) => b.version - a.version).map(v => (
                                        <div key={v.id} className="bg-white p-4 rounded-lg border border-gray-100 shadow-sm">
                                          <div className="flex items-center justify-between mb-2">
                                            <span className="text-xs font-bold text-gray-700">Version {v.version}</span>
                                            <span className="text-[10px] text-gray-400">{new Date(v.createdAt).toLocaleString()}</span>
                                          </div>
                                          <p className="text-xs text-gray-500 mb-2">{v.description}</p>
                                          <details className="text-[10px] text-blue-600 cursor-pointer">
                                            <summary className="hover:underline">View logic at this version</summary>
                                            <div className="mt-2 p-3 bg-gray-50 rounded border font-mono text-gray-600 overflow-x-auto">
                                              <ReactMarkdown>{v.logic}</ReactMarkdown>
                                            </div>
                                          </details>
                                        </div>
                                      ))}
                                    </div>
                                  </section>
                                </div>
                              </div>
                            ) : (
                              <div className="h-full flex flex-col items-center justify-center text-gray-400 p-12 text-center">
                                <div className="w-16 h-16 bg-gray-100 rounded-full flex items-center justify-center mb-4">
                                  <ScrollText className="w-8 h-8 opacity-20" />
                                </div>
                                <h4 className="text-sm font-bold text-gray-600 mb-1">Select a rule to view details</h4>
                                <p className="text-xs max-w-xs">Choose a business rule from the list on the left to see its full documentation and version history.</p>
                              </div>
                            )}
                          </div>
                        </div>
                      </div>
                    </div>
                  ) : activeElement ? (
                    <div className="flex-1 overflow-auto p-6 font-mono text-sm">
                      <AnimatePresence mode="wait">
                        <motion.div
                          key={activeTab}
                          initial={{ opacity: 0, x: 10 }}
                          animate={{ opacity: 1, x: 0 }}
                          exit={{ opacity: 0, x: -10 }}
                          className="h-full"
                        >
                          {activeTab === 'source' && (
                            <div className="space-y-4 flex flex-col h-full">
                              <div className="flex items-center justify-between bg-gray-50 p-2 rounded border">
                                <div className="flex items-center gap-4">
                                  <div className="flex items-center gap-2">
                                    <span className="text-xs font-bold text-gray-500 uppercase tracking-wider flex items-center gap-2">
                                      <Code2 className="w-3 h-3 text-blue-600" />
                                      Language:
                                    </span>
                                    <select 
                                      value={sourceViewLanguage}
                                      onChange={(e) => setSourceViewLanguage(e.target.value)}
                                      className="bg-white border border-gray-300 rounded px-2 py-1 text-xs font-bold text-gray-700 outline-none focus:ring-1 focus:ring-blue-500"
                                    >
                                      <option value="COBOL">COBOL</option>
                                      <option value="Python">Python</option>
                                      <option value="Java">Java</option>
                                      <option value="C">C</option>
                                    </select>
                                  </div>
                                  <div className="flex items-center gap-2">
                                    <span className="text-xs font-bold text-gray-500 uppercase tracking-wider flex items-center gap-2">
                                      <FileCode className="w-3 h-3" />
                                      File:
                                    </span>
                                    <select 
                                      value={activeElement.id}
                                      onChange={(e) => setActiveElement(elements.find(el => el.id === e.target.value) || null)}
                                      className="bg-white border border-gray-300 rounded px-2 py-1 text-xs font-bold text-gray-700 outline-none focus:ring-1 focus:ring-blue-500"
                                    >
                                      {elements
                                        .filter(el => {
                                          if (sourceViewLanguage === 'COBOL') return true;
                                          return el.targetLanguage.toLowerCase() === sourceViewLanguage.toLowerCase() && el.convertedContent;
                                        })
                                        .map(el => (
                                          <option key={el.id} value={el.id}>{el.name}</option>
                                        ))}
                                    </select>
                                  </div>
                                  <button 
                                    onClick={() => setIsAddingElement(true)}
                                    className="flex items-center gap-1.5 px-2 py-1 bg-blue-600 text-white rounded text-[10px] font-bold hover:bg-blue-700 transition-all shadow-sm"
                                  >
                                    <Plus className="w-3 h-3" />
                                    Add Source
                                  </button>
                                </div>
                                <div className="flex items-center gap-2">
                                  <span className="text-[10px] text-gray-400 mr-4">/repository/{activeProject.name}/source/{activeElement.name}</span>
                                  {isEditingSource ? (
                                    <>
                                      <button 
                                        onClick={() => setIsEditingSource(false)}
                                        className="px-2 py-1 bg-gray-200 text-gray-700 rounded text-[10px] font-bold hover:bg-gray-300"
                                      >
                                        Cancel
                                      </button>
                                      <button 
                                        onClick={handleSaveSourceEdit}
                                        className="px-2 py-1 bg-green-600 text-white rounded text-[10px] font-bold hover:bg-green-700 flex items-center gap-1"
                                      >
                                        <Save className="w-2.5 h-2.5" />
                                        Save
                                      </button>
                                    </>
                                  ) : (
                                    <button 
                                      onClick={() => {
                                        setEditedContent(activeElement.content);
                                        setIsEditingSource(true);
                                      }}
                                      className="px-2 py-1 bg-blue-50 text-blue-600 rounded text-[10px] font-bold hover:bg-blue-100 flex items-center gap-1"
                                    >
                                      <Edit className="w-2.5 h-2.5" />
                                      Edit
                                    </button>
                                  )}
                                </div>
                              </div>
                              {isEditingSource ? (
                                <textarea
                                  value={editedContent}
                                  onChange={(e) => setEditedContent(e.target.value)}
                                  className="flex-1 p-4 bg-gray-900 text-gray-100 rounded-lg font-mono text-sm outline-none resize-none leading-relaxed"
                                />
                              ) : (
                                <pre className="p-4 bg-gray-900 text-gray-100 rounded-lg overflow-x-auto leading-relaxed flex-1">
                                  {sourceViewLanguage === 'COBOL' ? activeElement.content : activeElement.convertedContent}
                                </pre>
                              )}
                            </div>
                          )}
                          {activeTab === 'destination' && (
                            <div className="space-y-4 flex flex-col h-full">
                              <div className="flex items-center justify-between bg-gray-50 p-2 rounded border">
                                <div className="flex items-center gap-4">
                                  <div className="flex items-center gap-2">
                                    <span className="text-xs font-bold text-gray-500 uppercase tracking-wider flex items-center gap-2">
                                      <Code2 className="w-3 h-3 text-blue-600" />
                                      Language:
                                    </span>
                                    <select 
                                      value={viewLanguage}
                                      onChange={(e) => setViewLanguage(e.target.value)}
                                      className="bg-white border border-gray-300 rounded px-2 py-1 text-xs font-bold text-gray-700 outline-none focus:ring-1 focus:ring-blue-500"
                                    >
                                      <option value="Java">Java</option>
                                      <option value="Python">Python</option>
                                      <option value="C">C</option>
                                    </select>
                                  </div>
                                  <div className="flex items-center gap-2">
                                    <span className="text-xs font-bold text-gray-500 uppercase tracking-wider">File:</span>
                                    <select 
                                      value={activeElement.id}
                                      onChange={(e) => setActiveElement(elements.find(el => el.id === e.target.value) || null)}
                                      className="bg-white border border-gray-300 rounded px-2 py-1 text-xs font-bold text-gray-700 outline-none focus:ring-1 focus:ring-blue-500"
                                    >
                                      {elements
                                        .filter(el => el.convertedContent && el.targetLanguage.toLowerCase() === viewLanguage.toLowerCase())
                                        .map(el => (
                                          <option key={el.id} value={el.id}>{el.name.split('.')[0]}.{el.targetLanguage === 'Java' ? 'java' : el.targetLanguage === 'C' ? 'c' : 'py'}</option>
                                        ))}
                                    </select>
                                  </div>
                                </div>
                                <div className="flex items-center gap-2">
                                  <span className="text-[10px] text-gray-400 mr-4">/repository/{activeProject.name}/output/{activeElement.name}/destination-output/</span>
                                  {activeElement.convertedContent && (
                                    isEditingDestination ? (
                                      <>
                                        <button 
                                          onClick={() => setIsEditingDestination(false)}
                                          className="px-2 py-1 bg-gray-200 text-gray-700 rounded text-[10px] font-bold hover:bg-gray-300"
                                        >
                                          Cancel
                                        </button>
                                        <button 
                                          onClick={handleSaveDestinationEdit}
                                          className="px-2 py-1 bg-green-600 text-white rounded text-[10px] font-bold hover:bg-green-700 flex items-center gap-1"
                                        >
                                          <Save className="w-2.5 h-2.5" />
                                          Save
                                        </button>
                                      </>
                                    ) : (
                                      <button 
                                        onClick={() => {
                                          setEditedContent(activeElement.convertedContent || '');
                                          setIsEditingDestination(true);
                                        }}
                                        className="px-2 py-1 bg-blue-50 text-blue-600 rounded text-[10px] font-bold hover:bg-blue-100 flex items-center gap-1"
                                      >
                                        <Edit className="w-2.5 h-2.5" />
                                        Edit
                                      </button>
                                    )
                                  )}
                                </div>
                              </div>
                              {isEditingDestination ? (
                                <textarea
                                  value={editedContent}
                                  onChange={(e) => setEditedContent(e.target.value)}
                                  className="flex-1 p-4 bg-gray-900 text-gray-100 rounded-lg font-mono text-sm outline-none resize-none leading-relaxed"
                                />
                              ) : activeElement.convertedContent ? (
                                <div className="flex-1 overflow-auto">
                                  <div className="bg-gray-900 text-gray-100 p-4 rounded-lg overflow-x-auto min-h-full">
                                    <ReactMarkdown>
                                      {`\`\`\`${activeProject.targetLanguage.toLowerCase()}\n${activeElement.convertedContent}\n\`\`\``}
                                    </ReactMarkdown>
                                  </div>
                                </div>
                              ) : (
                                <div className="h-64 flex flex-col items-center justify-center text-gray-400 border-2 border-dashed rounded-lg">
                                  <Code2 className="w-12 h-12 mb-2 opacity-20" />
                                  <p>No converted code yet. Click "Convert Code" to start.</p>
                                </div>
                              )}
                            </div>
                          )}
                          {activeTab === 'synthetic-data' && (
                            <div className="space-y-6 h-full flex flex-col">
                              <div className="flex items-center justify-between">
                                <div>
                                  <h3 className="text-lg font-bold">
                                    {selectedInputFile ? `Editing: ${selectedInputFile.name}` : 'Synthetic Data Generation'}
                                  </h3>
                                  <p className="text-xs text-gray-500">Generate or load test data based on COBOL file structures.</p>
                                </div>
                                <div className="flex items-center gap-3">
                                  {selectedInputFile && (
                                    <button 
                                      onClick={() => {
                                        setSelectedInputFile(null);
                                        setSyntheticData('');
                                        setActiveTab('input');
                                      }}
                                      className="px-3 py-1.5 bg-gray-100 text-gray-600 rounded text-xs font-bold hover:bg-gray-200"
                                    >
                                      Cancel
                                    </button>
                                  )}
                                  <label className="flex items-center gap-2 px-3 py-1.5 bg-white border border-gray-300 rounded text-xs font-bold hover:bg-gray-50 cursor-pointer">
                                    <Upload className="w-3 h-3" />
                                    Load Input File
                                    <input type="file" className="hidden" onChange={handleLoadSyntheticInput} />
                                  </label>
                                  <button 
                                    onClick={handleGenerateSyntheticData}
                                    disabled={isGeneratingData}
                                    className="flex items-center gap-2 px-3 py-1.5 bg-blue-600 text-white rounded text-xs font-bold hover:bg-blue-700 disabled:opacity-50"
                                  >
                                    {isGeneratingData ? <div className="animate-spin rounded-full h-3 w-3 border-b-2 border-white"></div> : <Database className="w-3 h-3" />}
                                    Generate Data
                                  </button>
                                  {syntheticData && (
                                    <button 
                                      onClick={handleSaveSyntheticData}
                                      className="flex items-center gap-2 px-3 py-1.5 bg-green-600 text-white rounded text-xs font-bold hover:bg-green-700"
                                    >
                                      <Save className="w-3 h-3" />
                                      {selectedInputFile ? 'Update File' : 'Save to Repo'}
                                    </button>
                                  )}
                                </div>
                              </div>

                              {/* New Dropdowns and Inputs */}
                              <div className="grid grid-cols-1 md:grid-cols-3 gap-4 bg-white p-4 rounded-lg border shadow-sm">
                                <div className="space-y-1.5">
                                  <label className="text-[10px] font-bold text-gray-400 uppercase tracking-wider block">Source Code Layout</label>
                                  <select 
                                    value={selectedSyntheticSourceId}
                                    onChange={(e) => setSelectedSyntheticSourceId(e.target.value)}
                                    className="w-full bg-gray-50 border border-gray-200 rounded px-3 py-2 text-xs focus:ring-2 focus:ring-blue-500 outline-none"
                                  >
                                    <option value="">Active Element (Default)</option>
                                    {elements.map(el => (
                                      <option key={el.id} value={el.id}>{el.name}</option>
                                    ))}
                                  </select>
                                </div>
                                <div className="space-y-1.5">
                                  <label className="text-[10px] font-bold text-gray-400 uppercase tracking-wider block">Input File Template</label>
                                  <select 
                                    value={selectedSyntheticInputId}
                                    onChange={(e) => setSelectedSyntheticInputId(e.target.value)}
                                    className="w-full bg-gray-50 border border-gray-200 rounded px-3 py-2 text-xs focus:ring-2 focus:ring-blue-500 outline-none"
                                  >
                                    <option value="">None (Optional)</option>
                                    {inputFiles.map(f => (
                                      <option key={f.id} value={f.id}>{f.name}</option>
                                    ))}
                                  </select>
                                </div>
                                <div className="space-y-1.5">
                                  <label className="text-[10px] font-bold text-gray-400 uppercase tracking-wider block">No. of Records</label>
                                  <input 
                                    type="number"
                                    min={1}
                                    max={100}
                                    value={numRecords}
                                    onChange={(e) => setNumRecords(parseInt(e.target.value) || 1)}
                                    className="w-full bg-gray-50 border border-gray-200 rounded px-3 py-2 text-xs focus:ring-2 focus:ring-blue-500 outline-none"
                                  />
                                </div>
                              </div>

                              <div className="flex-1 flex flex-col border rounded-lg overflow-hidden bg-gray-50">
                                <div className="bg-gray-100 p-2 text-[10px] font-bold uppercase text-gray-500 border-b flex justify-between items-center">
                                  <span>Data Preview (Fixed-Width Format)</span>
                                  {syntheticData && <span className="text-blue-600">{syntheticData.split('\n').filter(l => l.trim()).length} Rows</span>}
                                </div>
                                <ByteRuler width={100} />
                                <textarea
                                  value={syntheticData}
                                  onChange={(e) => setSyntheticData(e.target.value)}
                                  placeholder="Generated or loaded data will appear here..."
                                  className="flex-1 p-4 font-mono text-xs bg-gray-900 text-green-400 outline-none resize-none leading-relaxed"
                                />
                              </div>
                              
                              <div className="bg-blue-50 p-4 rounded-lg border border-blue-100">
                                <h4 className="text-xs font-bold text-blue-800 mb-2 uppercase tracking-wider">How it works</h4>
                                <p className="text-xs text-blue-700 leading-relaxed">
                                  The AI analyzes the <strong>File Description (FD)</strong> and <strong>Working-Storage</strong> sections of your COBOL code to determine the exact byte-offsets and data types. It then generates realistic values that adhere to these constraints, ensuring the data is compatible with the legacy logic.
                                </p>
                              </div>
                            </div>
                          )}
                          {activeTab === 'report' && (
                            <div className="space-y-6">
                              <div className="flex items-center justify-between">
                                <h3 className="text-lg font-bold flex items-center gap-2">
                                  <BarChart3 className="w-5 h-5 text-blue-600" />
                                  Modernization Report
                                </h3>
                                <div className="inline-flex items-center bg-gray-100 rounded-lg p-1">
                                  <button
                                    onClick={() => setReportSubTab('summary')}
                                    className={cn("px-3 py-1 text-xs font-bold rounded-md", reportSubTab === 'summary' ? "bg-white text-blue-700 shadow-sm" : "text-gray-600")}
                                  >
                                    Summary
                                  </button>
                                  <button
                                    onClick={() => setReportSubTab('kpi')}
                                    className={cn("px-3 py-1 text-xs font-bold rounded-md", reportSubTab === 'kpi' ? "bg-white text-blue-700 shadow-sm" : "text-gray-600")}
                                  >
                                    KPI
                                  </button>
                                </div>
                              </div>
                              {report ? (
                                <div className="space-y-4">
                                  {reportSubTab === 'summary' && (
                                  <>
                                  <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                                    <div className="bg-blue-50 p-4 rounded-xl border border-blue-100">
                                      <p className="text-xs text-blue-600 font-bold uppercase">Total Lines</p>
                                      <p className="text-3xl font-bold text-blue-900">{report.totalLines}</p>
                                    </div>
                                    <div className="bg-green-50 p-4 rounded-xl border border-green-100">
                                      <p className="text-xs text-green-600 font-bold uppercase">Converted Lines</p>
                                      <p className="text-3xl font-bold text-green-900">{report.convertedLines}</p>
                                    </div>
                                    <div className="bg-purple-50 p-4 rounded-xl border border-purple-100">
                                      <p className="text-xs text-purple-600 font-bold uppercase">Success Rate</p>
                                      <p className="text-3xl font-bold text-purple-900">
                                        {report.totalLines > 0 ? Math.round((report.convertedLines / report.totalLines) * 100) : 0}%
                                      </p>
                                    </div>
                                  </div>
                                  <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                                    <div className="bg-red-50 p-4 rounded-xl border border-red-100">
                                      <p className="text-xs text-red-600 font-bold uppercase">Errors</p>
                                      <p className="text-3xl font-bold text-red-900">{report.errors.length}</p>
                                    </div>
                                    <div className="bg-amber-50 p-4 rounded-xl border border-amber-100">
                                      <p className="text-xs text-amber-600 font-bold uppercase">Warnings</p>
                                      <p className="text-3xl font-bold text-amber-900">{report.warnings.length}</p>
                                    </div>
                                    <div className="bg-gray-50 p-4 rounded-xl border border-gray-200">
                                      <p className="text-xs text-gray-600 font-bold uppercase">Unsupported Statements</p>
                                      <p className="text-3xl font-bold text-gray-900">{report.unsupportedStatements.length}</p>
                                    </div>
                                  </div>
                                  </>
                                  )}
                                  {reportSubTab === 'kpi' && (() => {
                                    const ps: any = normalizeProgramStats(
                                      report.programStatistics || {},
                                      (activeElement?.name || 'UNKNOWN').split('.')[0],
                                      report.totalLines || 0
                                    );

                                    if (!report.programStatistics) {
                                      ps.sizeMetrics.linesOfCode = report.totalLines || ps.sizeMetrics.linesOfCode;
                                      ps.summary.keyIssues = [
                                        ...(report.errors?.length ? [`${report.errors.length} conversion errors`] : []),
                                        ...(report.warnings?.length ? [`${report.warnings.length} conversion warnings`] : []),
                                      ];
                                      ps.conversionReadiness.unsupportedConstructs = report.unsupportedStatements || [];
                                    }

                                    const sectionOrder = [
                                      'sizeMetrics',
                                      'complexityMetrics',
                                      'dataMetrics',
                                      'fileMetrics',
                                      'databaseMetrics',
                                      'dependencyMetrics',
                                      'cicsMetrics',
                                      'qualityMetrics',
                                      'conversionReadiness',
                                      'performanceIndicators',
                                      'securityIndicators',
                                      'maintainability',
                                      'summary'
                                    ];

                                    const sectionTitle: Record<string, string> = {
                                      sizeMetrics: 'Size Metrics',
                                      complexityMetrics: 'Complexity Metrics',
                                      dataMetrics: 'Data Metrics',
                                      fileMetrics: 'File Metrics',
                                      databaseMetrics: 'Database Metrics',
                                      dependencyMetrics: 'Dependency Metrics',
                                      cicsMetrics: 'CICS Metrics',
                                      qualityMetrics: 'Quality Metrics',
                                      conversionReadiness: 'Conversion Readiness',
                                      performanceIndicators: 'Performance Indicators',
                                      securityIndicators: 'Security Indicators',
                                      maintainability: 'Maintainability',
                                      summary: 'Summary'
                                    };

                                    const formatLabel = (key: string) => key
                                      .replace(/([A-Z])/g, ' $1')
                                      .replace(/^./, (s) => s.toUpperCase());

                                    const formatValue = (value: any) => {
                                      if (Array.isArray(value)) return value.length ? value.join(', ') : 'N/A';
                                      if (typeof value === 'boolean') return value ? 'Yes' : 'No';
                                      if (value === null || value === undefined || value === '') return 'N/A';
                                      return String(value);
                                    };

                                    return (
                                      <div className="space-y-4">
                                        {!report.programStatistics && (
                                          <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 text-xs text-amber-800">
                                            Showing KPI view generated from legacy report fields. Run Convert Code once to refresh all KPI metrics with full analyzer output.
                                          </div>
                                        )}
                                        <div className="bg-indigo-50 p-4 rounded-xl border border-indigo-100">
                                          <p className="text-xs text-indigo-600 font-bold uppercase">Program Name</p>
                                          <p className="text-xl font-bold text-indigo-900">{ps.programName || activeElement?.name || 'Unknown Program'}</p>
                                        </div>

                                        {sectionOrder.map((sectionKey) => {
                                          const sectionData = ps[sectionKey];
                                          if (!sectionData || typeof sectionData !== 'object') return null;
                                          const isOpen = openKpiSections.includes(sectionKey);

                                          return (
                                            <div key={sectionKey} className="bg-white rounded-xl border border-gray-200">
                                              <button
                                                onClick={() => setOpenKpiSections(prev => prev.includes(sectionKey) ? prev.filter(s => s !== sectionKey) : [...prev, sectionKey])}
                                                className="w-full flex items-center justify-between p-4 text-left"
                                              >
                                                <h4 className="text-xs font-bold uppercase tracking-wider text-gray-600">{sectionTitle[sectionKey] || formatLabel(sectionKey)}</h4>
                                                {isOpen ? <ChevronUp className="w-4 h-4 text-gray-500" /> : <ChevronDown className="w-4 h-4 text-gray-500" />}
                                              </button>
                                              {isOpen && (
                                                <div className="px-4 pb-4 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                                                  {Object.entries(sectionData).map(([k, v]) => (
                                                    <div key={k} className="bg-gray-50 border border-gray-100 rounded-lg p-3">
                                                      <p className="text-[10px] font-bold uppercase text-gray-500">{formatLabel(k)}</p>
                                                      <p className="text-sm font-semibold text-gray-900 mt-1 break-words">{formatValue(v)}</p>
                                                    </div>
                                                  ))}
                                                </div>
                                              )}
                                            </div>
                                          );
                                        })}
                                      </div>
                                    );
                                  })()}
                                </div>
                              ) : (
                                <div className="p-12 text-center text-gray-400 border rounded-xl border-dashed">
                                  <p>No report available yet.</p>
                                </div>
                              )}
                            </div>
                          )}
                          {activeTab === 'repository' && (
                            <div className={cn(
                              "space-y-6 h-full flex flex-col overflow-auto",
                              isRepoMaximized ? "fixed inset-0 z-[100] bg-white p-8" : ""
                            )}>
                              <div className="flex items-center justify-between">
                                <div className="flex items-center gap-4">
                                  <div className="flex items-center gap-2">
                                    <FolderOpen className={cn("w-5 h-5", `text-${themes[theme].accent}-600`)} />
                                    <h3 className={cn("text-lg font-bold", themes[theme].text)}>Project Repository</h3>
                                  </div>
                                  <button 
                                    onClick={() => setIsRepoMaximized(!isRepoMaximized)}
                                    className="p-1.5 hover:bg-gray-100 rounded text-gray-400 hover:text-blue-600 transition-colors"
                                    title={isRepoMaximized ? "Minimize" : "Maximize"}
                                  >
                                    {isRepoMaximized ? <Minimize2 className="w-4 h-4" /> : <Maximize2 className="w-4 h-4" />}
                                  </button>
                                </div>
                                <div className="flex items-center gap-2">
                                  <div className="relative mr-2">
                                    <Search className="w-3.5 h-3.5 text-gray-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
                                    <input 
                                      type="text"
                                      placeholder="Search elements..."
                                      value={repoSearchTerm}
                                      onChange={(e) => setRepoSearchTerm(e.target.value)}
                                      className="pl-8 pr-3 py-1.5 bg-gray-100 border-none rounded text-xs focus:ring-1 focus:ring-blue-500 w-48"
                                    />
                                  </div>
                                  <div className="flex items-center gap-2 mr-2">
                                    <select 
                                      value={selectedFolder}
                                      onChange={(e) => setSelectedFolder(e.target.value)}
                                      className="bg-gray-100 border-none rounded px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider outline-none focus:ring-1 focus:ring-blue-500"
                                    >
                                      {repositoryFolders.map(folder => (
                                        <option key={folder} value={folder}>{folder}</option>
                                      ))}
                                    </select>
                                    <label className="flex items-center gap-2 px-3 py-1.5 bg-blue-600 text-white rounded text-[10px] font-bold hover:bg-blue-700 cursor-pointer transition-all uppercase tracking-wider">
                                      <Upload className="w-3 h-3" />
                                      Upload
                                      <input type="file" className="hidden" onChange={(e) => handleFileUpload(e, 'input')} />
                                    </label>
                                  </div>
                                  <button 
                                    onClick={() => setCollapsedElements([])}
                                    className="px-3 py-1.5 bg-gray-100 text-gray-600 rounded text-[10px] font-bold hover:bg-gray-200 uppercase tracking-wider"
                                  >
                                    Expand All
                                  </button>
                                  <button 
                                    onClick={() => setCollapsedElements(elements.map(e => e.id))}
                                    className="px-3 py-1.5 bg-gray-100 text-gray-600 rounded text-[10px] font-bold hover:bg-gray-200 uppercase tracking-wider"
                                  >
                                    Collapse All
                                  </button>
                                  <button 
                                    onClick={fetchFiles}
                                    className="flex items-center gap-2 px-3 py-1.5 bg-blue-50 text-blue-600 rounded text-[10px] font-bold hover:bg-blue-100 uppercase tracking-wider ml-2"
                                  >
                                    <ArrowLeftRight className="w-3 h-3" />
                                    Refresh
                                  </button>
                                </div>
                              </div>

                              <div className="flex-1 overflow-auto p-4 space-y-3">
                                {elements
                                  .filter(e => e.name.toLowerCase().includes(repoSearchTerm.toLowerCase()))
                                  .filter(e => !selectedFolder || selectedFolder === 'Default' || e.folder === selectedFolder)
                                  .map(element => {
                                  const elementInputFiles = inputFiles.filter(f => f.elementId === element.id);
                                  const elementOutputFiles = outputFiles.filter(f => f.elementId === element.id);
                                  const sourceOutputs = elementOutputFiles.filter(f => f.type === 'Source');
                                  const destinationOutputs = elementOutputFiles.filter(f => f.type === 'Destination' || !f.type);
                                  
                                  const isCollapsed = collapsedElements.includes(element.id);
                                  const isElementMaximized = maximizedElements.includes(element.id);

                                  return (
                                    <div key={element.id} className={cn(
                                      "bg-white border rounded-lg shadow-sm overflow-hidden transition-all duration-200",
                                      isCollapsed ? "hover:border-blue-300" : "border-blue-100 ring-1 ring-blue-50",
                                      isElementMaximized ? "fixed inset-4 z-[110] bg-white shadow-2xl flex flex-col" : ""
                                    )}>
                                      <div className={cn(
                                        "px-4 py-2 flex items-center justify-between cursor-pointer select-none",
                                        isCollapsed ? "bg-white" : "bg-blue-50/50 border-b border-blue-100"
                                      )}
                                      onClick={() => toggleElementCollapse(element.id)}
                                      >
                                        <div className="flex items-center gap-3">
                                          <div className="p-1 hover:bg-gray-200 rounded transition-colors">
                                            {isCollapsed ? <ChevronRight className="w-3.5 h-3.5 text-gray-400" /> : <ChevronDown className="w-3.5 h-3.5 text-blue-500" />}
                                          </div>
                                          <FileCode className={cn("w-4 h-4", isCollapsed ? "text-gray-400" : "text-blue-600")} />
                                          <div className="flex items-center gap-3">
                                            <h4 className={cn("text-xs font-bold", isCollapsed ? "text-gray-600" : "text-gray-900")}>{element.name}</h4>
                                            <span className="text-[10px] bg-white px-2 py-0.5 rounded border border-gray-200 text-gray-500 font-medium uppercase tracking-wider">{element.targetLanguage}</span>
                                          </div>
                                        </div>
                                        <div className="flex items-center gap-4">
                                          <div className="flex items-center gap-3 text-[10px] font-bold text-gray-400 uppercase tracking-widest">
                                            <span>{elementInputFiles.length} Inputs</span>
                                            <span>{elementOutputFiles.length} Outputs</span>
                                          </div>
                                          <div className="flex items-center gap-1">
                                            <select 
                                              value={element.folder || 'Default'}
                                              onChange={(e) => {
                                                const newFolder = e.target.value;
                                                updateDoc(doc(db, 'elements', element.id), { folder: newFolder });
                                              }}
                                              onClick={(e) => e.stopPropagation()}
                                              className="bg-white border border-gray-200 rounded px-2 py-1 text-[9px] font-bold uppercase tracking-wider outline-none focus:ring-1 focus:ring-blue-500 mr-1"
                                              title="Move to Folder"
                                            >
                                              {repositoryFolders.map(folder => (
                                                <option key={folder} value={folder}>{folder}</option>
                                              ))}
                                            </select>
                                            <button 
                                              onClick={(e) => {
                                                e.stopPropagation();
                                                toggleElementMaximize(element.id);
                                              }}
                                              className="p-1.5 hover:bg-gray-200 rounded text-gray-400 hover:text-blue-600 transition-colors"
                                              title={isElementMaximized ? "Minimize Element" : "Maximize Element"}
                                            >
                                              {isElementMaximized ? <Minimize2 className="w-3.5 h-3.5" /> : <Maximize2 className="w-3.5 h-3.5" />}
                                            </button>
                                            <button 
                                              onClick={(e) => {
                                                e.stopPropagation();
                                                setActiveElement(element);
                                                setActiveTab('ide');
                                              }}
                                              className="px-2 py-1 bg-white border border-blue-200 text-blue-600 rounded text-[10px] font-bold hover:bg-blue-50 transition-colors"
                                            >
                                              Open IDE
                                            </button>
                                          </div>
                                        </div>
                                      </div>
                                      
                                      {!isCollapsed && (
                                        <div className={cn(
                                          "p-3 grid grid-cols-1 md:grid-cols-2 gap-4 animate-in fade-in slide-in-from-top-1 duration-200",
                                          isElementMaximized ? "flex-1 overflow-auto" : ""
                                        )}>
                                        {/* Input Files Section */}
                                        <div className="space-y-2">
                                          <h5 className="text-[10px] font-bold text-gray-400 uppercase tracking-widest flex items-center justify-between gap-2">
                                            <div className="flex items-center gap-2">
                                              <Database className="w-3 h-3" /> Input Files
                                            </div>
                                            <button 
                                              onClick={() => setIsCreatingFile({ type: 'input', elementId: element.id })}
                                              className="p-1 text-blue-600 hover:bg-blue-50 rounded"
                                              title="Create Input File"
                                            >
                                              <Plus className="w-3 h-3" />
                                            </button>
                                          </h5>
                                          {elementInputFiles.length > 0 ? elementInputFiles.map(file => (
                                            <div key={file.id} className="flex items-center justify-between p-2 bg-gray-50 rounded border group">
                                              <div className="flex items-center gap-2 overflow-hidden flex-1">
                                                <Folder className="w-3.5 h-3.5 text-amber-500 shrink-0" />
                                                {renamingFile?.id === file.id ? (
                                                  <div className="flex items-center gap-1 flex-1">
                                                    <input 
                                                      autoFocus
                                                      value={newName}
                                                      onChange={(e) => setNewName(e.target.value)}
                                                      onKeyDown={(e) => e.key === 'Enter' && handleRenameFile()}
                                                      className="text-xs border rounded px-1 py-0.5 w-full bg-white"
                                                    />
                                                    <button onClick={handleRenameFile} className="text-blue-600"><Check className="w-3 h-3" /></button>
                                                    <button onClick={() => setRenamingFile(null)} className="text-gray-400"><X className="w-3 h-3" /></button>
                                                  </div>
                                                ) : (
                                                  <span className="text-xs font-medium truncate">{file.name}</span>
                                                )}
                                              </div>
                                              <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                                                <button 
                                                  onClick={() => handleMoveFile(file, 'input', element.id)}
                                                  className="p-1 text-gray-400 hover:text-blue-600"
                                                  title="Move to Output"
                                                >
                                                  <ArrowRight className="w-3 h-3" />
                                                </button>
                                                <button 
                                                  onClick={() => handleEditFile(file, 'input', element.id)}
                                                  className="p-1 text-gray-400 hover:text-blue-600"
                                                  title="Edit Content"
                                                >
                                                  <Eye className="w-3 h-3" />
                                                </button>
                                                <button 
                                                  onClick={() => {
                                                    setRenamingFile({ id: file.id, name: file.name, type: 'input', elementId: element.id });
                                                    setNewName(file.name);
                                                  }}
                                                  className="p-1 text-gray-400 hover:text-blue-600"
                                                  title="Rename"
                                                >
                                                  <Edit className="w-3 h-3" />
                                                </button>
                                                <button 
                                                  onClick={() => handleDeleteInputFile(file.id, element.id)}
                                                  className="p-1 text-gray-400 hover:text-red-600"
                                                >
                                                  <Trash2 className="w-3 h-3" />
                                                </button>
                                              </div>
                                            </div>
                                          )) : (
                                            <p className="text-[10px] text-gray-400 italic py-2">No input files</p>
                                          )}
                                        </div>

                                        {/* Output Files Section */}
                                        <div className="space-y-4">
                                          <div className="space-y-2">
                                            <h5 className="text-[10px] font-bold text-gray-400 uppercase tracking-widest flex items-center justify-between gap-2">
                                              <div className="flex items-center gap-2">
                                                <Database className="w-3 h-3" /> Source Output (COBOL)
                                              </div>
                                              <button 
                                                onClick={() => setIsCreatingFile({ type: 'output', elementId: element.id })}
                                                className="p-1 text-blue-600 hover:bg-blue-50 rounded"
                                                title="Create Source Output"
                                              >
                                                <Plus className="w-3 h-3" />
                                              </button>
                                            </h5>
                                            {sourceOutputs.length > 0 ? sourceOutputs.map(file => (
                                              <div key={file.id} className="flex items-center justify-between p-2 bg-amber-50/30 rounded border border-amber-100 group">
                                                <div className="flex items-center gap-2 overflow-hidden flex-1">
                                                  <FileCode className="w-3.5 h-3.5 text-amber-500 shrink-0" />
                                                  {renamingFile?.id === file.id ? (
                                                    <div className="flex items-center gap-1 flex-1">
                                                      <input 
                                                        autoFocus
                                                        value={newName}
                                                        onChange={(e) => setNewName(e.target.value)}
                                                        onKeyDown={(e) => e.key === 'Enter' && handleRenameFile()}
                                                        className="text-xs border rounded px-1 py-0.5 w-full bg-white"
                                                      />
                                                      <button onClick={handleRenameFile} className="text-blue-600"><Check className="w-3 h-3" /></button>
                                                      <button onClick={() => setRenamingFile(null)} className="text-gray-400"><X className="w-3 h-3" /></button>
                                                    </div>
                                                  ) : (
                                                    <span className="text-xs font-medium truncate">{file.name}</span>
                                                  )}
                                                </div>
                                                <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                                                  <button 
                                                    onClick={() => handleMoveFile(file, 'output', element.id)}
                                                    className="p-1 text-gray-400 hover:text-blue-600"
                                                    title="Move to Input"
                                                  >
                                                    <ArrowLeft className="w-3 h-3" />
                                                  </button>
                                                  <button 
                                                    onClick={() => handleEditFile(file, 'output', element.id)}
                                                    className="p-1 text-gray-400 hover:text-blue-600"
                                                    title="Edit Content"
                                                  >
                                                    <Eye className="w-3 h-3" />
                                                  </button>
                                                  <button 
                                                    onClick={() => {
                                                      setRenamingFile({ id: file.id, name: file.name, type: 'output', elementId: element.id });
                                                      setNewName(file.name);
                                                    }}
                                                    className="p-1 text-gray-400 hover:text-blue-600"
                                                    title="Rename"
                                                  >
                                                    <Edit className="w-3 h-3" />
                                                  </button>
                                                  <button 
                                                    onClick={() => handleDeleteOutputFile(file.id, element.id)}
                                                    className="p-1 text-gray-400 hover:text-red-600"
                                                  >
                                                    <Trash2 className="w-3 h-3" />
                                                  </button>
                                                </div>
                                              </div>
                                            )) : (
                                              <p className="text-[10px] text-gray-400 italic py-1">No source outputs</p>
                                            )}
                                          </div>

                                          <div className="space-y-2">
                                            <h5 className="text-[10px] font-bold text-gray-400 uppercase tracking-widest flex items-center justify-between gap-2">
                                              <div className="flex items-center gap-2">
                                                <Database className="w-3 h-3" /> Destination Output ({element.targetLanguage.toUpperCase()})
                                              </div>
                                              <button 
                                                onClick={() => setIsCreatingFile({ type: 'output', elementId: element.id })}
                                                className="p-1 text-blue-600 hover:bg-blue-50 rounded"
                                                title="Create Destination Output"
                                              >
                                                <Plus className="w-3 h-3" />
                                              </button>
                                            </h5>
                                            {destinationOutputs.length > 0 ? destinationOutputs.map(file => (
                                              <div key={file.id} className="flex items-center justify-between p-2 bg-blue-50/30 rounded border border-blue-100 group">
                                                <div className="flex items-center gap-2 overflow-hidden flex-1">
                                                  <FileCode className="w-3.5 h-3.5 text-blue-500 shrink-0" />
                                                  {renamingFile?.id === file.id ? (
                                                    <div className="flex items-center gap-1 flex-1">
                                                      <input 
                                                        autoFocus
                                                        value={newName}
                                                        onChange={(e) => setNewName(e.target.value)}
                                                        onKeyDown={(e) => e.key === 'Enter' && handleRenameFile()}
                                                        className="text-xs border rounded px-1 py-0.5 w-full bg-white"
                                                      />
                                                      <button onClick={handleRenameFile} className="text-blue-600"><Check className="w-3 h-3" /></button>
                                                      <button onClick={() => setRenamingFile(null)} className="text-gray-400"><X className="w-3 h-3" /></button>
                                                    </div>
                                                  ) : (
                                                    <span className="text-xs font-medium truncate">{file.name}</span>
                                                  )}
                                                </div>
                                                <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                                                  <button 
                                                    onClick={() => handleMoveFile(file, 'output', element.id)}
                                                    className="p-1 text-gray-400 hover:text-blue-600"
                                                    title="Move to Input"
                                                  >
                                                    <ArrowLeft className="w-3 h-3" />
                                                  </button>
                                                  <button 
                                                    onClick={() => handleEditFile(file, 'output', element.id)}
                                                    className="p-1 text-gray-400 hover:text-blue-600"
                                                    title="Edit Content"
                                                  >
                                                    <Eye className="w-3 h-3" />
                                                  </button>
                                                  <button 
                                                    onClick={() => {
                                                      setRenamingFile({ id: file.id, name: file.name, type: 'output', elementId: element.id });
                                                      setNewName(file.name);
                                                    }}
                                                    className="p-1 text-gray-400 hover:text-blue-600"
                                                    title="Rename"
                                                  >
                                                    <Edit className="w-3 h-3" />
                                                  </button>
                                                  <button 
                                                    onClick={() => handleDeleteOutputFile(file.id, element.id)}
                                                    className="p-1 text-gray-400 hover:text-red-600"
                                                  >
                                                    <Trash2 className="w-3 h-3" />
                                                  </button>
                                                </div>
                                              </div>
                                            )) : (
                                              <p className="text-[10px] text-gray-400 italic py-1">No destination outputs</p>
                                            )}
                                          </div>
                                        </div>
                                        </div>
                                      )}
                                    </div>
                                  );
                                })}
                                
                                {/* Server Files Section */}
                                <div className="bg-gray-900 text-white border border-gray-800 rounded-lg shadow-sm overflow-hidden mt-4">
                                  <div className="bg-gray-800 px-4 py-3 border-b border-gray-700 flex items-center justify-between">
                                    <div className="flex items-center gap-3">
                                      <button 
                                        onClick={() => setIsServerRepoCollapsed(!isServerRepoCollapsed)}
                                        className="p-1 hover:bg-gray-700 rounded transition-colors"
                                      >
                                        {isServerRepoCollapsed ? <ChevronRight className="w-4 h-4 text-gray-400" /> : <ChevronDown className="w-4 h-4 text-gray-400" />}
                                      </button>
                                      <Server className="w-5 h-5 text-green-400" />
                                      <div>
                                        <h4 className="text-sm font-bold">Server Repository</h4>
                                        <p className="text-[10px] text-gray-500 uppercase tracking-wider">Local File System</p>
                                      </div>
                                    </div>
                                  </div>
                                  {!isServerRepoCollapsed && (
                                    <div className="p-4 grid grid-cols-1 md:grid-cols-2 gap-6">
                                      <div className="space-y-2">
                                        <h5 className="text-[10px] font-bold text-gray-500 uppercase tracking-widest flex items-center justify-between">
                                          Input Repository
                                          <button 
                                            onClick={() => setIsCreatingFile({ type: 'input', elementId: 'server' })}
                                            className="p-1 text-green-400 hover:bg-gray-700 rounded"
                                            title="Create Server Input File"
                                          >
                                            <Plus className="w-3 h-3" />
                                          </button>
                                        </h5>
                                        <div className="max-h-48 overflow-y-auto space-y-1 pr-2">
                                          {serverFiles.inputs.map(f => (
                                            <div key={f} className="flex items-center justify-between p-2 bg-gray-800/50 rounded border border-gray-700 group">
                                              <div className="flex items-center gap-2 overflow-hidden flex-1">
                                                {renamingFile?.name === f && renamingFile?.type === 'server-input' ? (
                                                  <div className="flex items-center gap-1 flex-1">
                                                    <input 
                                                      autoFocus
                                                      value={newName}
                                                      onChange={(e) => setNewName(e.target.value)}
                                                      onKeyDown={(e) => e.key === 'Enter' && handleRenameFile()}
                                                      className="text-xs border border-gray-600 rounded px-1 py-0.5 w-full bg-gray-700 text-white"
                                                    />
                                                    <button onClick={handleRenameFile} className="text-green-400"><Check className="w-3 h-3" /></button>
                                                    <button onClick={() => setRenamingFile(null)} className="text-gray-500"><X className="w-3 h-3" /></button>
                                                  </div>
                                                ) : (
                                                  <span className="text-xs truncate">{f}</span>
                                                )}
                                              </div>
                                              <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                                                <button 
                                                  onClick={() => setImportingFile({ name: f, type: 'input' })}
                                                  className="p-1 text-gray-500 hover:text-blue-400"
                                                  title="Import to Element"
                                                >
                                                  <ArrowRight className="w-3 h-3" />
                                                </button>
                                                <button 
                                                  onClick={() => handleEditFile(f, 'server-input')}
                                                  className="p-1 text-gray-500 hover:text-blue-400"
                                                  title="Edit Content"
                                                >
                                                  <Eye className="w-3 h-3" />
                                                </button>
                                                <button 
                                                  onClick={() => {
                                                    setRenamingFile({ id: f, name: f, type: 'server-input' });
                                                    setNewName(f);
                                                  }}
                                                  className="p-1 text-gray-500 hover:text-blue-400"
                                                  title="Rename"
                                                >
                                                  <Edit className="w-3 h-3" />
                                                </button>
                                                <button onClick={() => handleDeleteServerFile(f, 'input')} className="p-1 text-gray-500 hover:text-red-400">
                                                  <Trash2 className="w-3 h-3" />
                                                </button>
                                              </div>
                                            </div>
                                          ))}
                                        </div>
                                      </div>
                                      <div className="space-y-2">
                                        <h5 className="text-[10px] font-bold text-gray-500 uppercase tracking-widest flex items-center justify-between">
                                          Output Repository
                                          <button 
                                            onClick={() => setIsCreatingFile({ type: 'output', elementId: 'server' })}
                                            className="p-1 text-green-400 hover:bg-gray-700 rounded"
                                            title="Create Server Output File"
                                          >
                                            <Plus className="w-3 h-3" />
                                          </button>
                                        </h5>
                                        <div className="max-h-48 overflow-y-auto space-y-1 pr-2">
                                          {serverFiles.outputs.map(f => (
                                            <div key={f} className="flex items-center justify-between p-2 bg-gray-800/50 rounded border border-gray-700 group">
                                              <div className="flex items-center gap-2 overflow-hidden flex-1">
                                                {renamingFile?.name === f && renamingFile?.type === 'server-output' ? (
                                                  <div className="flex items-center gap-1 flex-1">
                                                    <input 
                                                      autoFocus
                                                      value={newName}
                                                      onChange={(e) => setNewName(e.target.value)}
                                                      onKeyDown={(e) => e.key === 'Enter' && handleRenameFile()}
                                                      className="text-xs border border-gray-600 rounded px-1 py-0.5 w-full bg-gray-700 text-white"
                                                    />
                                                    <button onClick={handleRenameFile} className="text-green-400"><Check className="w-3 h-3" /></button>
                                                    <button onClick={() => setRenamingFile(null)} className="text-gray-500"><X className="w-3 h-3" /></button>
                                                  </div>
                                                ) : (
                                                  <span className="text-xs truncate">{f}</span>
                                                )}
                                              </div>
                                              <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                                                <button 
                                                  onClick={() => setImportingFile({ name: f, type: 'output' })}
                                                  className="p-1 text-gray-500 hover:text-blue-400"
                                                  title="Import to Element"
                                                >
                                                  <ArrowRight className="w-3 h-3" />
                                                </button>
                                                <button 
                                                  onClick={() => handleEditFile(f, 'server-output')}
                                                  className="p-1 text-gray-500 hover:text-blue-400"
                                                  title="Edit Content"
                                                >
                                                  <Eye className="w-3 h-3" />
                                                </button>
                                                <button 
                                                  onClick={() => {
                                                    setRenamingFile({ id: f, name: f, type: 'server-output' });
                                                    setNewName(f);
                                                  }}
                                                  className="p-1 text-gray-500 hover:text-blue-400"
                                                  title="Rename"
                                                >
                                                  <Edit className="w-3 h-3" />
                                                </button>
                                                <button onClick={() => handleDeleteServerFile(f, 'output')} className="p-1 text-gray-500 hover:text-red-400">
                                                  <Trash2 className="w-3 h-3" />
                                                </button>
                                              </div>
                                            </div>
                                          ))}
                                        </div>
                                      </div>
                                    </div>
                                  )}
                                </div>

                                {/* Create File Overlay */}
                                {isCreatingFile && (
                                  <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
                                    <div className="bg-white rounded-xl shadow-2xl w-full max-w-2xl flex flex-col max-h-[90vh]">
                                      <div className="p-4 border-b flex items-center justify-between bg-gray-50 rounded-t-xl">
                                        <h3 className="font-bold flex items-center gap-2 text-gray-800">
                                          <Plus className="w-5 h-5 text-blue-600" />
                                          Create New {isCreatingFile.type === 'input' ? 'Input' : 'Output'} File
                                          {isCreatingFile.elementId === 'server' && <span className="text-[10px] bg-green-100 text-green-700 px-2 py-0.5 rounded ml-2 font-bold uppercase tracking-wider">Server</span>}
                                        </h3>
                                        <button onClick={() => setIsCreatingFile(null)} className="text-gray-400 hover:text-gray-600">
                                          <X className="w-5 h-5" />
                                        </button>
                                      </div>
                                      <div className="p-6 space-y-4 overflow-auto">
                                        <div className="space-y-1">
                                          <label className="text-[10px] font-bold text-gray-500 uppercase tracking-widest">File Name</label>
                                          <input 
                                            autoFocus
                                            value={newFileName}
                                            onChange={(e) => setNewFileName(e.target.value)}
                                            placeholder="e.g. input_data.txt"
                                            className="w-full border rounded-lg p-3 text-sm focus:ring-2 focus:ring-blue-500 outline-none"
                                          />
                                        </div>
                                        <div className="space-y-1 flex-1 flex flex-col min-h-[300px]">
                                          <label className="text-[10px] font-bold text-gray-500 uppercase tracking-widest">File Content</label>
                                          <textarea 
                                            value={newFileContent}
                                            onChange={(e) => setNewFileContent(e.target.value)}
                                            placeholder="Enter file content here..."
                                            className="w-full flex-1 border rounded-lg p-3 text-sm font-mono focus:ring-2 focus:ring-blue-500 outline-none resize-none"
                                          />
                                        </div>
                                      </div>
                                      <div className="p-4 border-t bg-gray-50 rounded-b-xl flex justify-end gap-3">
                                        <button 
                                          onClick={() => setIsCreatingFile(null)}
                                          className="px-4 py-2 text-sm font-medium text-gray-600 hover:bg-gray-200 rounded-lg transition-colors"
                                        >
                                          Cancel
                                        </button>
                                        <button 
                                          onClick={async () => {
                                            if (isCreatingFile.elementId === 'server') {
                                              try {
                                                await axios.post('/api/files/create', {
                                                  name: newFileName,
                                                  content: newFileContent,
                                                  type: isCreatingFile.type
                                                });
                                                toast.success('Server file created');
                                                fetchFiles();
                                                setIsCreatingFile(null);
                                                setNewFileName('');
                                                setNewFileContent('');
                                              } catch (err) {
                                                toast.error('Failed to create server file');
                                              }
                                            } else {
                                              handleCreateFile();
                                            }
                                          }}
                                          disabled={!newFileName}
                                          className="px-6 py-2 bg-blue-600 text-white text-sm font-bold rounded-lg hover:bg-blue-700 disabled:opacity-50 flex items-center gap-2 transition-colors shadow-sm"
                                        >
                                          <Save className="w-4 h-4" />
                                          Create File
                                        </button>
                                      </div>
                                    </div>
                                  </div>
                                )}

                                {/* Edit File Overlay */}
                                {editingFile && (
                                  <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
                                    <div className="bg-white rounded-xl shadow-2xl w-full max-w-4xl flex flex-col h-[90vh]">
                                      <div className="p-4 border-b flex items-center justify-between bg-gray-50 rounded-t-xl">
                                        <div className="flex items-center gap-3">
                                          <FileEdit className="w-5 h-5 text-blue-600" />
                                          <div>
                                            <h3 className="font-bold text-gray-800">Editing: {editingFile.name}</h3>
                                            <p className="text-[10px] text-gray-500 uppercase tracking-widest font-bold">
                                              {editingFile.type.includes('server') ? 'Server Repository' : 'Firestore Repository'} • {editingFile.type.replace('server-', '')} File
                                            </p>
                                          </div>
                                        </div>
                                        <button onClick={() => setEditingFile(null)} className="text-gray-400 hover:text-gray-600">
                                          <X className="w-5 h-5" />
                                        </button>
                                      </div>
                                      <div className="flex-1 p-0 overflow-hidden relative">
                                        <textarea 
                                          value={editingFile.content}
                                          onChange={(e) => setEditingFile({...editingFile, content: e.target.value})}
                                          className="w-full h-full p-6 text-sm font-mono focus:outline-none resize-none bg-gray-50 text-gray-800"
                                          spellCheck={false}
                                        />
                                        <div className="absolute top-0 left-0 w-full pointer-events-none">
                                          <ByteRuler width={100} />
                                        </div>
                                      </div>
                                      <div className="p-4 border-t bg-gray-50 rounded-b-xl flex justify-end gap-3">
                                        <button 
                                          onClick={() => setEditingFile(null)}
                                          className="px-4 py-2 text-sm font-medium text-gray-600 hover:bg-gray-200 rounded-lg transition-colors"
                                        >
                                          Cancel
                                        </button>
                                        <button 
                                          onClick={handleUpdateFileContent}
                                          className="px-6 py-2 bg-blue-600 text-white text-sm font-bold rounded-lg hover:bg-blue-700 flex items-center gap-2 transition-colors shadow-sm"
                                        >
                                          <Save className="w-4 h-4" />
                                          Save Changes
                                        </button>
                                      </div>
                                    </div>
                                  </div>
                                )}
                              </div>
                            </div>
                          )}
                          {activeTab === 'compare' && (
                            <div className="h-full flex flex-col space-y-4">
                              <div className="bg-gray-50 p-4 rounded-xl border space-y-4">
                                <div className="flex items-center gap-4">
                                  <div className="flex flex-col gap-1 flex-1">
                                    <label className="text-[10px] font-bold text-gray-400 uppercase tracking-wider">Filter by Element</label>
                                    <select 
                                      value={selectedCompareElementId}
                                      onChange={(e) => {
                                        setSelectedCompareElementId(e.target.value);
                                        setSelectedSourceFileId('');
                                        setSelectedDestinationFileId('');
                                      }}
                                      className="text-xs border rounded p-2 bg-white w-full"
                                    >
                                      <option value="">All Elements</option>
                                      {elements.map(el => (
                                        <option key={el.id} value={el.id}>{el.name}</option>
                                      ))}
                                    </select>
                                  </div>
                                  <div className="flex-1"></div>
                                </div>

                                <div className="flex items-center justify-between">
                                  <div className="flex items-center gap-4 flex-1">
                                    <div className="flex flex-col gap-1 flex-1">
                                      <label className="text-[10px] font-bold text-gray-400 uppercase tracking-wider">File A (Source)</label>
                                      <select 
                                        value={selectedSourceFileId}
                                        onChange={(e) => setSelectedSourceFileId(e.target.value)}
                                        className="text-xs border rounded p-2 bg-white w-full"
                                      >
                                        <option value="">Select File A</option>
                                        {[...inputFiles, ...outputFiles]
                                          .filter(f => !selectedCompareElementId || f.elementId === selectedCompareElementId)
                                          .map(f => {
                                            const isInput = inputFiles.some(i => i.id === f.id);
                                            const elementName = elements.find(el => el.id === f.elementId)?.name || 'Unknown Element';
                                            return (
                                              <option key={f.id} value={f.id}>
                                                [{isInput ? 'Input' : 'Output'}] {f.name} ({elementName})
                                              </option>
                                            );
                                          })}
                                      </select>
                                    </div>
                                    <div className="flex items-center justify-center text-gray-300">
                                      <ArrowLeftRight className="w-4 h-4" />
                                    </div>
                                    <div className="flex flex-col gap-1 flex-1">
                                      <label className="text-[10px] font-bold text-gray-400 uppercase tracking-wider">File B (Destination)</label>
                                      <select 
                                        value={selectedDestinationFileId}
                                        onChange={(e) => setSelectedDestinationFileId(e.target.value)}
                                        className="text-xs border rounded p-2 bg-white w-full"
                                      >
                                        <option value="">Select File B</option>
                                        {[...inputFiles, ...outputFiles]
                                          .filter(f => !selectedCompareElementId || f.elementId === selectedCompareElementId)
                                          .map(f => {
                                            const isInput = inputFiles.some(i => i.id === f.id);
                                            const elementName = elements.find(el => el.id === f.elementId)?.name || 'Unknown Element';
                                            return (
                                              <option key={f.id} value={f.id}>
                                                [{isInput ? 'Input' : 'Output'}] {f.name} ({elementName})
                                              </option>
                                            );
                                          })}
                                      </select>
                                    </div>
                                  </div>
                                  <button 
                                    onClick={handleCompareFiles}
                                    className="ml-4 px-6 py-2 bg-blue-600 text-white rounded-md text-sm font-bold hover:bg-blue-700 transition-all shadow-sm"
                                  >
                                    Compare Files
                                  </button>
                                </div>
                                
                                <div className="flex flex-wrap items-center gap-6 pt-2 border-t border-gray-200">
                                  <div className="flex items-center gap-4 border-r pr-6">
                                    <label className="text-[10px] font-bold text-gray-400 uppercase tracking-wider">Mode:</label>
                                    <div className="flex items-center gap-3">
                                      {[
                                        { id: 'full', label: 'Full Record' },
                                        { id: 'position', label: 'Position' },
                                        { id: 'key', label: 'Input Key' }
                                      ].map(m => (
                                        <label key={m.id} className="flex items-center gap-1.5 cursor-pointer group">
                                          <input 
                                            type="radio" 
                                            name="compareMode"
                                            checked={compareOptions.mode === m.id}
                                            onChange={() => setCompareOptions(prev => ({ ...prev, mode: m.id as any }))}
                                            className="text-blue-600 focus:ring-blue-500 w-3 h-3"
                                          />
                                          <span className={cn(
                                            "text-xs font-medium transition-colors",
                                            compareOptions.mode === m.id ? "text-blue-600" : "text-gray-500 group-hover:text-gray-700"
                                          )}>{m.label}</span>
                                        </label>
                                      ))}
                                    </div>
                                  </div>

                                  {compareOptions.mode === 'key' && (
                                    <div className="flex items-center gap-3 border-r pr-6 animate-in fade-in slide-in-from-left-2 duration-200">
                                      <div className="flex items-center gap-2">
                                        <label className="text-[10px] font-bold text-gray-400 uppercase tracking-wider">Start:</label>
                                        <input 
                                          type="number"
                                          value={compareOptions.keyStart}
                                          onChange={(e) => setCompareOptions(prev => ({ ...prev, keyStart: parseInt(e.target.value) || 0 }))}
                                          className="w-16 text-xs border rounded px-2 py-1 focus:ring-1 focus:ring-blue-500 outline-none"
                                          min="0"
                                        />
                                      </div>
                                      <div className="flex items-center gap-2">
                                        <label className="text-[10px] font-bold text-gray-400 uppercase tracking-wider">Len:</label>
                                        <input 
                                          type="number"
                                          value={compareOptions.keyLength}
                                          onChange={(e) => setCompareOptions(prev => ({ ...prev, keyLength: parseInt(e.target.value) || 0 }))}
                                          className="w-16 text-xs border rounded px-2 py-1 focus:ring-1 focus:ring-blue-500 outline-none"
                                          min="1"
                                        />
                                      </div>
                                    </div>
                                  )}

                                  <div className="flex items-center gap-4">
                                    <div className="flex items-center gap-2">
                                      <input 
                                        type="checkbox" 
                                        id="ignoreWhitespace" 
                                        checked={compareOptions.ignoreWhitespace}
                                        onChange={(e) => setCompareOptions(prev => ({ ...prev, ignoreWhitespace: e.target.checked }))}
                                        className="rounded text-blue-600 focus:ring-blue-500"
                                      />
                                      <label htmlFor="ignoreWhitespace" className="text-xs font-medium text-gray-600 cursor-pointer">Ignore Whitespace</label>
                                    </div>
                                    <div className="flex items-center gap-2">
                                      <input 
                                        type="checkbox" 
                                        id="ignoreCase" 
                                        checked={compareOptions.ignoreCase}
                                        onChange={(e) => setCompareOptions(prev => ({ ...prev, ignoreCase: e.target.checked }))}
                                        className="rounded text-blue-600 focus:ring-blue-500"
                                      />
                                      <label htmlFor="ignoreCase" className="text-xs font-medium text-gray-600 cursor-pointer">Ignore Case</label>
                                    </div>
                                  </div>
                                </div>
                              </div>

                              {comparisonSummary && (
                                <div className="grid grid-cols-5 gap-4">
                                  <div className="bg-white p-3 rounded-lg border flex flex-col items-center">
                                    <span className="text-[10px] font-bold text-gray-400 uppercase">Source Records</span>
                                    <span className="text-xl font-bold text-gray-900">{comparisonSummary.total}</span>
                                  </div>
                                  <div className="bg-green-50 p-3 rounded-lg border border-green-100 flex flex-col items-center">
                                    <span className="text-[10px] font-bold text-green-600 uppercase">Exact Matches</span>
                                    <span className="text-xl font-bold text-green-700">{comparisonSummary.matches}</span>
                                  </div>
                                  <div className="bg-amber-50 p-3 rounded-lg border border-amber-100 flex flex-col items-center">
                                    <span className="text-[10px] font-bold text-amber-600 uppercase">Partial (&gt;50%)</span>
                                    <span className="text-xl font-bold text-amber-700">{comparisonSummary.partials}</span>
                                  </div>
                                  <div className="bg-red-50 p-3 rounded-lg border border-red-100 flex flex-col items-center">
                                    <span className="text-[10px] font-bold text-red-600 uppercase">Unmapped Source</span>
                                    <span className="text-xl font-bold text-red-700">{comparisonSummary.mismatches}</span>
                                  </div>
                                  <div className="bg-gray-50 p-3 rounded-lg border border-gray-200 flex flex-col items-center">
                                    <span className="text-[10px] font-bold text-gray-500 uppercase">Unmapped Dest</span>
                                    <span className="text-xl font-bold text-gray-700">{comparisonSummary.unmatchedDest || 0}</span>
                                  </div>
                                </div>
                              )}

                              <div className="flex-1 overflow-hidden flex flex-col border rounded-xl bg-white">
                                <div className="grid grid-cols-2 bg-gray-100 border-b">
                                  <div className="p-2 text-[10px] font-bold uppercase text-gray-500 border-r">
                                    {inputFiles.some(f => f.id === selectedSourceFileId) ? 'Input File' : 'Source File'} (File A)
                                  </div>
                                  <div className="p-2 text-[10px] font-bold uppercase text-blue-600">
                                    {outputFiles.some(f => f.id === selectedDestinationFileId) ? 'Output File' : 'Destination File'} (File B)
                                  </div>
                                </div>
                                <div className="flex-1 overflow-auto font-mono text-xs">
                                  {comparisonResult ? (
                                    <div className="divide-y">
                                      {comparisonResult.map((line, idx) => (
                                        <div key={idx} className="grid grid-cols-2 hover:bg-gray-50/50 transition-colors">
                                          <div className={cn(
                                            "p-2 border-r break-all whitespace-pre-wrap relative",
                                            line.sourceLine ? (
                                              line.isMatch ? "bg-green-100 text-green-900" : 
                                              line.similarity > 0.5 ? "bg-amber-100 text-amber-900" :
                                              "bg-red-100 text-red-900"
                                            ) : "bg-gray-50 text-gray-400"
                                          )}>
                                            <span className="inline-block w-8 text-[8px] text-gray-400 select-none">{line.sourceIndex || '-'}</span>
                                            {line.sourceLine || <span className="opacity-20 italic">no record</span>}
                                            {!line.isMatch && line.similarity > 0.5 && line.sourceLine && (
                                              <span className="absolute top-1 right-1 text-[8px] font-bold text-amber-600 bg-white px-1 rounded border border-amber-200">
                                                {Math.round(line.similarity * 100)}% Match
                                              </span>
                                            )}
                                          </div>
                                          <div className={cn(
                                            "p-2 break-all whitespace-pre-wrap relative",
                                            line.destLine ? (
                                              line.isMatch ? "bg-green-100 text-green-900" : 
                                              line.similarity > 0.5 ? "bg-amber-100 text-amber-900" :
                                              "bg-red-100 text-red-900"
                                            ) : "bg-gray-50 text-gray-400"
                                          )}>
                                            <span className="inline-block w-8 text-[8px] text-gray-400 select-none">{line.destIndex || '-'}</span>
                                            {line.destLine || <span className="opacity-20 italic">no match</span>}
                                            {!line.isMatch && line.similarity > 0.5 && line.destLine && (
                                              <span className="absolute top-1 right-1 text-[8px] font-bold text-amber-600 bg-white px-1 rounded border border-amber-200">
                                                {Math.round(line.similarity * 100)}% Match
                                              </span>
                                            )}
                                          </div>
                                        </div>
                                      ))}
                                    </div>
                                  ) : (
                                    <div className="h-full flex flex-col items-center justify-center text-gray-400 p-12 text-center">
                                      <ArrowLeftRight className="w-12 h-12 mb-4 opacity-10" />
                                      <p className="text-sm font-medium">Select files above and click "Compare" to see differences.</p>
                                    </div>
                                  )}
                                </div>
                              </div>
                            </div>
                          )}
                        </motion.div>
                      </AnimatePresence>
                    </div>
                  ) : (
                    <div className="flex-1 flex flex-col items-center justify-center text-gray-400 p-12 text-center">
                      <div className="bg-gray-50 p-8 rounded-full mb-6">
                        <FileCode className="w-16 h-16 opacity-10" />
                      </div>
                      <h2 className="text-xl font-bold text-gray-600 mb-2">No Element Selected</h2>
                      <p className="max-w-xs mb-6">Select a COBOL source element from the list on the left or add a new one to begin modernization.</p>
                      {activeTab === 'source' && (
                        <button 
                          onClick={() => setIsAddingElement(true)}
                          className="flex items-center gap-2 px-6 py-3 bg-blue-600 text-white rounded-xl font-bold hover:bg-blue-700 transition-all shadow-lg shadow-blue-500/20"
                        >
                          <Plus className="w-5 h-5" />
                          Add COBOL Source
                        </button>
                      )}
                    </div>
                  )}
                </div>
              </div>
            </>
          ) : (
            <div className="flex-1 flex flex-col items-center justify-center bg-gray-50 p-12 text-center">
              <div className="max-w-md space-y-6">
                <div className="bg-white p-12 rounded-3xl shadow-xl border border-gray-100">
                  <Layout className="w-20 h-20 text-blue-600 mx-auto mb-6 opacity-20" />
                  <h2 className="text-2xl font-bold text-gray-800 mb-4">Welcome to COBOL Modernizer</h2>
                  <p className="text-gray-500 mb-8">Select a project from the sidebar or create a new one to start modernizing your COBOL infrastructure.</p>
                  <button 
                    onClick={() => setIsCreatingProject(true)}
                    className="w-full bg-blue-600 hover:bg-blue-700 text-white font-bold py-3 px-6 rounded-xl transition-all shadow-lg shadow-blue-500/20"
                  >
                    Create Your First Project
                  </button>
                </div>
              </div>
            </div>
          )}
        </main>
      </div>

      {/* Modals */}
      <AnimatePresence>
        {isCreatingProject && (
          <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-[100] p-4">
            <motion.div 
              initial={{ scale: 0.9, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.9, opacity: 0 }}
              className="bg-white rounded-2xl shadow-2xl w-full max-w-md overflow-hidden"
            >
              <div className="bg-[#001639] p-6 text-white">
                <h2 className="text-xl font-bold">New Modernization Project</h2>
                <p className="text-blue-300 text-xs mt-1">Define your modernization target and scope.</p>
              </div>
              <div className="p-6 space-y-4">
                <div>
                  <label className="block text-xs font-bold text-gray-500 uppercase mb-1">Project Name</label>
                  <input 
                    type="text" 
                    value={newProject.name}
                    onChange={e => setNewProject({...newProject, name: e.target.value})}
                    placeholder="e.g., Payroll System Modernization"
                    className="w-full border rounded-lg p-3 text-sm focus:ring-2 focus:ring-blue-500 outline-none"
                  />
                </div>
                <div>
                  <label className="block text-xs font-bold text-gray-500 uppercase mb-1">Description</label>
                  <textarea 
                    value={newProject.description}
                    onChange={e => setNewProject({...newProject, description: e.target.value})}
                    placeholder="Briefly describe the project goals..."
                    className="w-full border rounded-lg p-3 text-sm focus:ring-2 focus:ring-blue-500 outline-none h-24"
                  />
                </div>
                <div>
                  <label className="block text-xs font-bold text-gray-500 uppercase mb-1">Target Language</label>
                  <select 
                    value={newProject.targetLanguage}
                    onChange={e => setNewProject({...newProject, targetLanguage: e.target.value})}
                    className="w-full border rounded-lg p-3 text-sm focus:ring-2 focus:ring-blue-500 outline-none"
                  >
                    <option>Java</option>
                    <option>Python</option>
                    <option>C#</option>
                    <option>C++</option>
                    <option>C</option>
                  </select>
                </div>
                <div className="flex gap-3 pt-4">
                  <button 
                    onClick={() => setIsCreatingProject(false)}
                    className="flex-1 py-3 border rounded-xl font-bold text-gray-600 hover:bg-gray-50 transition-all"
                  >
                    Cancel
                  </button>
                  <button 
                    onClick={handleCreateProject}
                    className="flex-1 py-3 bg-blue-600 text-white rounded-xl font-bold hover:bg-blue-700 transition-all shadow-lg shadow-blue-500/20"
                  >
                    Create Project
                  </button>
                </div>
              </div>
            </motion.div>
          </div>
        )}

        {isAddingElement && (
          <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-[100] p-4">
            <motion.div 
              initial={{ scale: 0.9, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.9, opacity: 0 }}
              className="bg-white rounded-2xl shadow-2xl w-full max-w-4xl overflow-hidden"
            >
              <div className="bg-[#001639] p-6 text-white flex items-center justify-between">
                <div>
                  <h2 className="text-xl font-bold">Add COBOL Source</h2>
                  <p className="text-blue-300 text-xs mt-1">Paste your COBOL source code or upload multiple files.</p>
                </div>
                <label className="p-2 hover:bg-white/10 rounded-full cursor-pointer transition-all">
                  <Upload className="w-5 h-5" />
                  <input 
                    type="file" 
                    multiple 
                    accept=".cbl,.cob,.txt" 
                    className="hidden" 
                    onChange={handleElementUpload}
                  />
                </label>
              </div>
              <div className="p-6 space-y-4">
                <div>
                  <label className="block text-xs font-bold text-gray-500 uppercase mb-1">Element Name</label>
                  <input 
                    type="text" 
                    value={newElement.name}
                    onChange={e => setNewElement({...newElement, name: e.target.value})}
                    placeholder="e.g., PAYROLL.CBL"
                    className="w-full border rounded-lg p-3 text-sm focus:ring-2 focus:ring-blue-500 outline-none"
                  />
                </div>
                <div>
                  <label className="block text-xs font-bold text-gray-500 uppercase mb-1">COBOL Source Code</label>
                  <textarea 
                    value={newElement.content}
                    onChange={e => setNewElement({...newElement, content: e.target.value})}
                    placeholder="Paste COBOL code here..."
                    className="w-full border rounded-lg p-4 text-sm font-mono focus:ring-2 focus:ring-blue-500 outline-none h-[400px] bg-gray-50"
                  />
                </div>
                <div className="flex gap-3 pt-4">
                  <button 
                    onClick={() => setIsAddingElement(false)}
                    className="flex-1 py-3 border rounded-xl font-bold text-gray-600 hover:bg-gray-50 transition-all"
                  >
                    Cancel
                  </button>
                  <button 
                    onClick={handleAddElement}
                    className="flex-1 py-3 bg-blue-600 text-white rounded-xl font-bold hover:bg-blue-700 transition-all shadow-lg shadow-blue-500/20"
                  >
                    Add Element
                  </button>
                </div>
              </div>
            </motion.div>
          </div>
        )}

        {projectToDelete && (
          <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-[110] p-4">
            <motion.div 
              initial={{ scale: 0.9, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.9, opacity: 0 }}
              className="bg-white rounded-2xl shadow-2xl w-full max-w-md overflow-hidden"
            >
              <div className="p-6 text-center">
                <div className="w-16 h-16 bg-red-50 text-red-600 rounded-full flex items-center justify-center mx-auto mb-4">
                  <Trash2 className="w-8 h-8" />
                </div>
                <h2 className="text-xl font-bold text-gray-800 mb-2">Delete Project?</h2>
                <p className="text-gray-500 text-sm mb-6">
                  Are you sure you want to delete <span className="font-bold text-gray-700">"{projectToDelete.name}"</span>? 
                  This action cannot be undone and will remove all associated data.
                </p>
                <div className="flex gap-3">
                  <button 
                    onClick={() => setProjectToDelete(null)}
                    className="flex-1 py-3 border rounded-xl font-bold text-gray-600 hover:bg-gray-50 transition-all"
                  >
                    Cancel
                  </button>
                  <button 
                    onClick={handleDeleteProject}
                    className="flex-1 py-3 bg-red-600 text-white rounded-xl font-bold hover:bg-red-700 transition-all shadow-lg shadow-red-500/20"
                  >
                    Delete Project
                  </button>
                </div>
              </div>
            </motion.div>
          </div>
        )}

        {elementToDelete && (
          <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-[110] p-4">
            <motion.div 
              initial={{ scale: 0.9, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.9, opacity: 0 }}
              className="bg-white rounded-2xl shadow-2xl w-full max-w-md overflow-hidden"
            >
              <div className="p-6 text-center">
                <div className="w-16 h-16 bg-red-50 text-red-600 rounded-full flex items-center justify-center mx-auto mb-4">
                  <Trash2 className="w-8 h-8" />
                </div>
                <h2 className="text-xl font-bold text-gray-800 mb-2">Delete Source Element?</h2>
                <p className="text-gray-500 text-sm mb-6">
                  Are you sure you want to delete <span className="font-bold text-gray-700">"{elementToDelete.name}"</span>? 
                  This will also delete the destination code, reports, input/output files, and test cases.
                </p>
                <div className="flex gap-3">
                  <button 
                    onClick={() => setElementToDelete(null)}
                    className="flex-1 py-3 border rounded-xl font-bold text-gray-600 hover:bg-gray-50 transition-all"
                  >
                    Cancel
                  </button>
                  <button 
                    onClick={handleDeleteElement}
                    className="flex-1 py-3 bg-red-600 text-white rounded-xl font-bold hover:bg-red-700 transition-all shadow-lg shadow-red-500/20"
                  >
                    Delete Everything
                  </button>
                </div>
              </div>
            </motion.div>
          </div>
        )}

        {importingFile && (
          <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-[110] p-4">
            <motion.div 
              initial={{ scale: 0.9, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.9, opacity: 0 }}
              className="bg-white rounded-2xl shadow-2xl w-full max-w-md overflow-hidden"
            >
              <div className="bg-[#001639] p-6 text-white flex items-center justify-between">
                <div>
                  <h2 className="text-xl font-bold">Import to Element</h2>
                  <p className="text-blue-300 text-xs mt-1">Select target element for {importingFile.name}</p>
                </div>
                <button onClick={() => setImportingFile(null)} className="p-2 hover:bg-white/10 rounded-full transition-all">
                  <X className="w-5 h-5" />
                </button>
              </div>
              <div className="p-6 space-y-4 max-h-[60vh] overflow-y-auto">
                <div className="space-y-2">
                  {elements.map((element) => (
                      <div className="flex flex-col gap-2 w-full">
                        <div className="flex items-center justify-between p-3 bg-gray-50 rounded-xl border border-gray-100 transition-all group">
                          <div className="flex items-center gap-3">
                            <div className="p-2 bg-blue-100 text-blue-600 rounded-lg">
                              <FileCode className="w-4 h-4" />
                            </div>
                            <div className="text-left">
                              <p className="text-sm font-bold text-gray-700">{element.name}</p>
                              <p className="text-[10px] text-gray-400 uppercase tracking-wider">{element.targetLanguage}</p>
                            </div>
                          </div>
                        </div>
                        {importingFile.type === 'output' ? (
                          <div className="flex gap-2 pl-4">
                            <button
                              onClick={() => {
                                handleImportFromServer(importingFile.name, importingFile.type, element.id, 'Source');
                                setImportingFile(null);
                              }}
                              className="flex-1 py-2 bg-amber-50 text-amber-700 border border-amber-200 rounded-lg text-[10px] font-bold hover:bg-amber-100 transition-all"
                            >
                              Import as Source (COBOL)
                            </button>
                            <button
                              onClick={() => {
                                handleImportFromServer(importingFile.name, importingFile.type, element.id, 'Destination');
                                setImportingFile(null);
                              }}
                              className="flex-1 py-2 bg-blue-50 text-blue-700 border border-blue-200 rounded-lg text-[10px] font-bold hover:bg-blue-100 transition-all"
                            >
                              Import as Destination ({element.targetLanguage.toUpperCase()})
                            </button>
                          </div>
                        ) : (
                          <div className="pl-4">
                            <button
                              onClick={() => {
                                handleImportFromServer(importingFile.name, importingFile.type, element.id);
                                setImportingFile(null);
                              }}
                              className="w-full py-2 bg-gray-100 text-gray-700 border border-gray-200 rounded-lg text-[10px] font-bold hover:bg-gray-200 transition-all"
                            >
                              Import as Input File
                            </button>
                          </div>
                        )}
                      </div>
                  ))}
                  {elements.length === 0 && (
                    <p className="text-center text-gray-400 py-8 italic text-sm">No elements found in this project.</p>
                  )}
                </div>
              </div>
              <div className="p-6 pt-0">
                <button 
                  onClick={() => setImportingFile(null)}
                  className="w-full py-3 border rounded-xl font-bold text-gray-600 hover:bg-gray-50 transition-all"
                >
                  Cancel
                </button>
              </div>
            </motion.div>
          </div>
        )}

      </AnimatePresence>
      <div className="dynamic-cursor" />
    </div>
  );
}
