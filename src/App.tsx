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
  signOut, 
  onAuthStateChanged, 
  collection, 
  doc, 
  addDoc, 
  onSnapshot, 
  query, 
  where, 
  updateDoc,
  deleteDoc,
  getDocs,
  type User,
  OperationType,
  handleFirestoreError
} from './firebase';
import { GoogleGenAI } from "@google/genai";
import { 
  Layout, 
  Plus, 
  Folder, 
  FileCode, 
  Play, 
  CheckCircle, 
  AlertCircle, 
  BarChart3, 
  TestTube2, 
  ArrowLeftRight, 
  LogOut, 
  ChevronRight, 
  Upload,
  Search,
  Settings,
  Bell,
  HelpCircle,
  MoreVertical,
  Code2,
  Database,
  Save,
  Trash2,
  Edit,
  Edit3,
  Copy,
  ArrowRight
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
}

interface ConversionReport {
  id: string;
  elementId: string;
  totalLines: number;
  convertedLines: number;
  errors: string[];
  warnings: string[];
  unsupportedStatements: string[];
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

const IDERunner = () => {
  const [code, setCode] = useState('');
  const [language, setLanguage] = useState('python');
  const [inputFiles, setInputFiles] = useState<{inputs: string[], outputs: string[]}>({inputs: [], outputs: []});
  const [selectedInput, setSelectedInput] = useState('');
  const [output, setOutput] = useState('');
  const [isRunning, setIsRunning] = useState(false);
  const [isMaximized, setIsMaximized] = useState(false);

  const fetchFiles = async () => {
    try {
      const res = await axios.get('/api/files');
      setInputFiles(res.data);
    } catch (err) {
      toast.error('Failed to fetch files');
    }
  };

  useEffect(() => {
    fetchFiles();
  }, []);

  const handleRun = async () => {
    setIsRunning(true);
    setOutput('Running...\n');
    try {
      const res = await axios.post('/api/run', {
        code,
        language,
        inputFileName: selectedInput
      });
      setOutput((res.data.stdout || '') + '\n' + (res.data.stderr || ''));
      if (res.data.outputFileName) {
        toast.success(`Output written to ${res.data.outputFileName}`);
        fetchFiles();
      }
    } catch (err: any) {
      setOutput('Error: ' + (err.response?.data?.error || err.message));
    } finally {
      setIsRunning(false);
    }
  };

  return (
    <div className={cn(
      "flex flex-col h-full bg-[#1e1e1e] text-white transition-all",
      isMaximized ? "fixed inset-0 z-[100] p-4" : "relative"
    )}>
      <div className="flex items-center justify-between p-2 bg-[#2d2d2d] border-b border-[#3e3e3e] rounded-t-lg">
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2">
            <span className="text-[10px] font-bold text-gray-400 uppercase tracking-wider">Language:</span>
            <select 
              value={language} 
              onChange={(e) => setLanguage(e.target.value)}
              className="bg-[#3c3c3c] text-white text-xs rounded px-2 py-1 border border-[#4e4e4e] focus:ring-1 focus:ring-blue-500 outline-none"
            >
              <option value="python">Python</option>
              <option value="cobol">COBOL</option>
            </select>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-[10px] font-bold text-gray-400 uppercase tracking-wider">Input File:</span>
            <select 
              value={selectedInput} 
              onChange={(e) => setSelectedInput(e.target.value)}
              className="bg-[#3c3c3c] text-white text-xs rounded px-2 py-1 border border-[#4e4e4e] focus:ring-1 focus:ring-blue-500 outline-none"
            >
              <option value="">No Input File</option>
              {inputFiles.inputs.map(f => <option key={f} value={f}>{f}</option>)}
            </select>
          </div>
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
        <div className="flex-1 border-r border-[#3e3e3e]">
          <Editor
            height="100%"
            language={language === 'python' ? 'python' : 'cobol'}
            theme="vs-dark"
            value={code}
            onChange={(v) => setCode(v || '')}
            options={{
              fontSize: 14,
              minimap: { enabled: false },
              scrollBeyondLastLine: false,
              automaticLayout: true,
              padding: { top: 10 }
            }}
          />
        </div>
        <div className="w-1/3 flex flex-col bg-[#1e1e1e]">
          <div className="p-2 bg-[#252526] text-[10px] font-bold uppercase tracking-wider text-gray-400 border-b border-[#3e3e3e] flex items-center gap-2">
            <Code2 className="w-3 h-3" /> Terminal / Output
          </div>
          <pre className="flex-1 p-4 font-mono text-sm overflow-auto whitespace-pre-wrap text-green-400 bg-[#000000]/30">
            {output || 'Output will appear here after execution...'}
          </pre>
          <div className="p-2 bg-[#252526] text-[10px] font-bold uppercase tracking-wider text-gray-400 border-t border-[#3e3e3e] flex items-center gap-2">
            <Folder className="w-3 h-3" /> Output Repository
          </div>
          <div className="h-48 overflow-y-auto p-2 bg-[#252526]/50">
            {inputFiles.outputs.length > 0 ? (
              inputFiles.outputs.map(f => (
                <div 
                  key={f} 
                  onClick={async () => {
                    try {
                      const res = await axios.get(`/api/files/content?name=${f}&type=output`);
                      setOutput(`--- Content of ${f} ---\n\n${res.data.content}`);
                    } catch (err) {
                      toast.error('Failed to read output file');
                    }
                  }}
                  className="flex items-center gap-2 text-xs py-1.5 px-2 hover:bg-[#2d2d2d] rounded cursor-pointer text-gray-300 group transition-colors"
                >
                  <FileCode className="w-3.5 h-3.5 text-blue-400" />
                  <span className="truncate flex-1">{f}</span>
                  <span className="text-[8px] text-gray-500 opacity-0 group-hover:opacity-100">View</span>
                </div>
              ))
            ) : (
              <div className="h-full flex flex-col items-center justify-center text-gray-600 italic text-[10px]">
                No output files generated yet
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

const Navbar = ({ user, onSignOut, onResetWorkspace }: { user: User; onSignOut: () => void; onResetWorkspace: () => void }) => (
  <nav className="h-14 bg-[#001639] text-white flex items-center justify-between px-4 border-b border-[#002b5c] sticky top-0 z-50">
    <div className="flex items-center gap-4">
      <div className="bg-[#00a1e0] p-1.5 rounded">
        <Database className="w-5 h-5 text-white" />
      </div>
      <span className="font-bold text-lg tracking-tight">ATLAS Modernizer</span>
      <div className="hidden md:flex items-center gap-6 ml-8 text-sm font-medium text-gray-300">
        <a href="#" className="hover:text-white border-b-2 border-transparent hover:border-[#00a1e0] h-14 flex items-center">Home</a>
        <a href="#" className="hover:text-white border-b-2 border-transparent hover:border-[#00a1e0] h-14 flex items-center">Projects</a>
        <a href="#" className="hover:text-white border-b-2 border-transparent hover:border-[#00a1e0] h-14 flex items-center">Reports</a>
      </div>
    </div>
    <div className="flex items-center gap-4">
      <div className="relative">
        <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
        <input 
          type="text" 
          placeholder="Search projects..." 
          className="bg-[#002b5c] border-none rounded-full py-1.5 pl-9 pr-4 text-sm focus:ring-2 focus:ring-[#00a1e0] w-64"
        />
      </div>
      <button className="p-2 hover:bg-[#002b5c] rounded-full"><Bell className="w-5 h-5" /></button>
      <button className="p-2 hover:bg-[#002b5c] rounded-full"><Settings className="w-5 h-5" /></button>
      <button 
        onClick={onResetWorkspace}
        className="flex items-center gap-2 px-3 py-1.5 bg-red-600/20 hover:bg-red-600/40 text-red-400 rounded-md text-xs font-bold transition-all border border-red-600/30"
        title="Delete all projects and start fresh"
      >
        <Trash2 className="w-3.5 h-3.5" />
        Reset Workspace
      </button>
      <div className="flex items-center gap-3 ml-2 pl-4 border-l border-[#002b5c]">
        <div className="text-right hidden sm:block">
          <p className="text-xs font-bold">{user.displayName}</p>
          <p className="text-[10px] text-gray-400">Developer</p>
        </div>
        <img src={user.photoURL || ''} alt="avatar" className="w-8 h-8 rounded-full border border-[#00a1e0]" />
        <button onClick={onSignOut} className="p-2 hover:bg-red-900/30 rounded-full text-red-400"><LogOut className="w-4 h-4" /></button>
      </div>
    </div>
  </nav>
);

const Sidebar = ({ projects, activeProject, onSelectProject, onCreateProject, onDeleteProject }: any) => (
  <div className="w-64 bg-gray-50 border-r flex flex-col h-[calc(100vh-3.5rem)]">
    <div className="p-4 border-b flex items-center justify-between bg-white">
      <h2 className="font-bold text-gray-700 uppercase text-xs tracking-wider">Projects</h2>
      <button 
        onClick={onCreateProject}
        className="p-1 hover:bg-blue-50 text-blue-600 rounded transition-colors"
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
                ? "bg-blue-50 border-r-4 border-blue-600 text-blue-700" 
                : "hover:bg-gray-100 text-gray-600"
            )}
          >
            <Folder className={cn("w-4 h-4", activeProject?.id === p.id ? "text-blue-600" : "text-gray-400")} />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-semibold truncate">{p.name}</p>
              <p className="text-[10px] opacity-70 truncate">{p.targetLanguage}</p>
            </div>
          </button>
          <button 
            onClick={(e) => {
              e.stopPropagation();
              onDeleteProject(p);
            }}
            className="absolute right-2 top-1/2 -translate-y-1/2 p-1.5 text-gray-400 hover:text-red-600 opacity-0 group-hover:opacity-100 transition-all"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
      ))}
      {projects.length === 0 && (
        <div className="p-8 text-center text-gray-400">
          <p className="text-xs italic">No projects yet</p>
        </div>
      )}
    </div>
  </div>
);

const TabButton = ({ active, label, icon: Icon, onClick }: any) => (
  <button
    onClick={onClick}
    className={cn(
      "flex items-center gap-2 px-6 py-3 text-sm font-medium transition-all border-b-2",
      active 
        ? "border-blue-600 text-blue-600 bg-white" 
        : "border-transparent text-gray-500 hover:text-gray-700 hover:bg-gray-50"
    )}
  >
    <Icon className="w-4 h-4" />
    {label}
  </button>
);

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [projects, setProjects] = useState<Project[]>([]);
  const [activeProject, setActiveProject] = useState<Project | null>(null);
  const [elements, setElements] = useState<SourceElement[]>([]);
  const [activeElement, setActiveElement] = useState<SourceElement | null>(null);
  const [activeTab, setActiveTab] = useState<'source' | 'destination' | 'input' | 'output' | 'report' | 'testing' | 'compare' | 'synthetic-data' | 'ide'>('source');
  const [isCreatingProject, setIsCreatingProject] = useState(false);
  const [isAddingElement, setIsAddingElement] = useState(false);
  const [newProject, setNewProject] = useState({ name: '', description: '', targetLanguage: 'Java' });
  const [newElement, setNewElement] = useState({ name: '', content: '' });
  const [isModernizing, setIsModernizing] = useState(false);
  const [isGeneratingData, setIsGeneratingData] = useState(false);
  const [isEditingSource, setIsEditingSource] = useState(false);
  const [isEditingDestination, setIsEditingDestination] = useState(false);
  const [editedContent, setEditedContent] = useState('');
  const [syntheticData, setSyntheticData] = useState('');
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
  const [comparisonResult, setComparisonResult] = useState<{ sourceLine: string, destLine: string, isMatch: boolean, similarity: number }[] | null>(null);
  const [compareOptions, setCompareOptions] = useState({ ignoreWhitespace: true, ignoreCase: false });
  const [comparisonSummary, setComparisonSummary] = useState<{ matches: number, mismatches: number, partials: number, total: number } | null>(null);
  const [selectedOutputFile, setSelectedOutputFile] = useState<any | null>(null);
  const [isEditingOutputFile, setIsEditingOutputFile] = useState(false);
  const [editingOutputFileContent, setEditingOutputFileContent] = useState('');

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (u) => {
      setUser(u);
      setLoading(false);
    });
    return unsubscribe;
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
        }
      } else {
        setActiveProject(null);
      }
    }, (err) => handleFirestoreError(err, OperationType.LIST, 'projects'));
    return unsubscribe;
  }, [user]);

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
        setReport({ id: snapshot.docs[0].id, ...snapshot.docs[0].data() } as ConversionReport);
      } else {
        setReport(null);
      }
    });
    return unsubscribe;
  }, [activeElement, activeProject]);

  useEffect(() => {
    if (!activeElement || !activeProject) {
      setInputFiles([]);
      return;
    }
    const q = query(collection(db, `projects/${activeProject.id}/elements/${activeElement.id}/inputFiles`));
    const unsubscribe = onSnapshot(q, (snapshot) => {
      setInputFiles(snapshot.docs.map(d => ({ id: d.id, ...d.data() })));
    });
    return unsubscribe;
  }, [activeElement, activeProject]);

  useEffect(() => {
    if (!activeElement || !activeProject) {
      setOutputFiles([]);
      setComparisonResult(null);
      setSelectedSourceFileId('');
      setSelectedDestinationFileId('');
      return;
    }
    const q = query(collection(db, `projects/${activeProject.id}/elements/${activeElement.id}/outputFiles`));
    const unsubscribe = onSnapshot(q, (snapshot) => {
      setOutputFiles(snapshot.docs.map(d => ({ id: d.id, ...d.data() })));
    });
    return unsubscribe;
  }, [activeElement, activeProject]);

  useEffect(() => {
    if (!activeElement || !activeProject) {
      setTestCases([]);
      return;
    }
    const q = query(collection(db, `projects/${activeProject.id}/elements/${activeElement.id}/testCases`));
    const unsubscribe = onSnapshot(q, (snapshot) => {
      setTestCases(snapshot.docs.map(d => ({ id: d.id, ...d.data() } as TestCase)));
    });
    return unsubscribe;
  }, [activeElement, activeProject]);

  const handleSignIn = async () => {
    try {
      console.log('Starting sign in with popup...');
      const result = await signInWithPopup(auth, googleProvider);
      console.log('Sign in successful:', result.user);
      toast.success('Successfully signed in');
    } catch (err: any) {
      console.error('Sign in error details:', err);
      toast.error(`Sign in failed: ${err.message || 'Unknown error'}`);
      if (err.code === 'auth/unauthorized-domain') {
        toast.error('Domain not authorized in Firebase Console. See instructions below.');
      }
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

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
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
        2. Add detailed inline comments at important code sections explaining the COBOL logic being modernized.
        3. If there are DB2 SQL statements, convert them to Oracle-compatible SQL.
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

      // Simple parsing for report
      const lines = elementContent.split('\n').length;
      const reportData = {
        totalLines: lines,
        convertedLines: lines,
        errors: [],
        warnings: [],
        unsupportedStatements: []
      };

      // Update element with converted code
      await updateDoc(doc(db, `projects/${projectId}/elements`, elementId), {
        convertedContent: convertedCode,
        status: 'Completed'
      });

      // Save report
      await addDoc(collection(db, `projects/${projectId}/elements/${elementId}/reports`), {
        elementId: elementId,
        ...reportData
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
    if (!activeElement || !activeProject) return;
    setIsGeneratingData(true);
    try {
      const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
      const prompt = `
        Analyze the following COBOL code and identify its input file structure (FD - File Description, record layouts).
        Then, generate 10 rows of synthetic test data that matches this structure.
        The data should be in a plain text format as it would appear in a COBOL flat file (fixed-width fields).
        
        COBOL Code:
        ${activeElement.content}
        
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

  const handleDeleteInputFile = async (fileId: string) => {
    if (!activeProject || !activeElement) return;
    try {
      await deleteDoc(doc(db, `projects/${activeProject.id}/elements/${activeElement.id}/inputFiles`, fileId));
      toast.success('File deleted');
    } catch (err) {
      handleFirestoreError(err, OperationType.DELETE, `projects/${activeProject.id}/elements/${activeElement.id}/inputFiles`);
    }
  };

  const handleDeleteOutputFile = async (fileId: string) => {
    if (!activeProject || !activeElement) return;
    try {
      await deleteDoc(doc(db, `projects/${activeProject.id}/elements/${activeElement.id}/outputFiles`, fileId));
      toast.success('Output file deleted');
      if (selectedOutputFile?.id === fileId) {
        setSelectedOutputFile(null);
        setIsEditingOutputFile(false);
        setEditingOutputFileContent('');
      }
    } catch (err) {
      handleFirestoreError(err, OperationType.DELETE, `projects/${activeProject.id}/elements/${activeElement.id}/outputFiles`);
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
      setActiveTab('testing');
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
    
    // Simple character-based similarity for fixed-width records
    let matches = 0;
    const maxLen = Math.max(s1.length, s2.length);
    const minLen = Math.min(s1.length, s2.length);
    
    for (let i = 0; i < minLen; i++) {
      if (s1[i] === s2[i]) matches++;
    }
    
    return matches / maxLen;
  };

  const handleCompareFiles = () => {
    if (!selectedSourceFileId || !selectedDestinationFileId) {
      toast.error('Please select both source and destination files');
      return;
    }

    const sourceFile = outputFiles.find(f => f.id === selectedSourceFileId);
    const destFile = outputFiles.find(f => f.id === selectedDestinationFileId);

    if (!sourceFile || !destFile) {
      toast.error('Selected files not found');
      return;
    }

    const sourceLines = (sourceFile.content || '').split('\n');
    const destLines = (destFile.content || '').split('\n');
    
    const maxLines = Math.max(sourceLines.length, destLines.length);
    const result = [];
    let matchCount = 0;
    let partialCount = 0;
    let mismatchCount = 0;

    for (let i = 0; i < maxLines; i++) {
      let sLine = sourceLines[i] || '';
      let dLine = destLines[i] || '';
      
      let sProcessed = sLine;
      let dProcessed = dLine;

      if (compareOptions.ignoreWhitespace) {
        sProcessed = sProcessed.trim();
        dProcessed = dProcessed.trim();
      }
      
      if (compareOptions.ignoreCase) {
        sProcessed = sProcessed.toLowerCase();
        dProcessed = dProcessed.toLowerCase();
      }

      const isExactMatch = sProcessed === dProcessed;
      const similarity = getSimilarity(sProcessed, dProcessed);
      
      if (isExactMatch) {
        matchCount++;
      } else if (similarity > 0.5) {
        partialCount++;
      } else {
        mismatchCount++;
      }

      result.push({
        sourceLine: sLine,
        destLine: dLine,
        isMatch: isExactMatch,
        similarity: similarity
      });
    }

    setComparisonResult(result);
    setComparisonSummary({
      matches: matchCount,
      partials: partialCount,
      mismatches: mismatchCount,
      total: maxLines
    });
    toast.success('Comparison complete');
  };

  if (loading) return <div className="h-screen flex items-center justify-center bg-gray-50"><div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600"></div></div>;

  if (!user) {
    return (
      <div className="h-screen flex flex-col items-center justify-center bg-[#001639] text-white p-4">
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
            <h1 className="text-4xl font-bold tracking-tight">ATLAS Modernizer</h1>
            <p className="text-gray-400">Enterprise COBOL Modernization Platform</p>
          </div>
          <button 
            onClick={handleSignIn}
            className="w-full bg-[#00a1e0] hover:bg-[#008bc2] text-white font-bold py-4 px-8 rounded-xl transition-all flex items-center justify-center gap-3 shadow-lg"
          >
            <img src="https://www.google.com/favicon.ico" className="w-5 h-5" alt="google" />
            Sign in with Google
          </button>
          <div className="pt-8 border-t border-[#002b5c]">
            <p className="text-xs text-gray-500">Accelerate your legacy transformation with AI-powered code conversion and DB2 to Oracle SQL migration.</p>
          </div>
        </motion.div>
      </div>
    );
  }

  return (
    <div className="h-screen flex flex-col bg-white overflow-hidden">
      <Toaster position="top-right" />
      <Navbar 
        user={user} 
        onSignOut={handleSignOut} 
        onResetWorkspace={async () => {
          if (confirm('Are you sure you want to reset your workspace? This will delete ALL your projects and data permanently.')) {
            try {
              const q = query(collection(db, 'projects'), where('createdBy', '==', user.uid));
              const snapshot = await getDocs(q);
              for (const d of snapshot.docs) {
                await deleteDoc(doc(db, 'projects', d.id));
              }
              setActiveProject(null);
              setActiveElement(null);
              toast.success('Workspace reset successfully');
            } catch (err) {
              toast.error('Failed to reset workspace');
            }
          }
        }}
      />
      
      <div className="flex flex-1 overflow-hidden">
        <Sidebar 
          projects={projects} 
          activeProject={activeProject} 
          onSelectProject={setActiveProject}
          onCreateProject={() => setIsCreatingProject(true)}
          onDeleteProject={setProjectToDelete}
        />

        <main className="flex-1 flex flex-col overflow-hidden">
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
                  <button 
                    onClick={handleModernize}
                    disabled={!activeElement || isModernizing}
                    className="flex items-center gap-2 px-4 py-2 bg-[#00a1e0] text-white rounded-md text-sm font-bold hover:bg-[#008bc2] disabled:opacity-50 transition-all shadow-md"
                  >
                    {isModernizing ? <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white"></div> : <Play className="w-4 h-4" />}
                    Convert Code
                  </button>
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
                      { name: 'tests', tab: 'testing' }
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
              <div className="bg-gray-50 border-b flex items-center px-6 overflow-x-auto scrollbar-hide shrink-0">
                <TabButton active={activeTab === 'source'} label="Source Code" icon={FileCode} onClick={() => setActiveTab('source')} />
                <TabButton active={activeTab === 'destination'} label="Destination Code" icon={Code2} onClick={() => setActiveTab('destination')} />
                <TabButton active={activeTab === 'synthetic-data'} label="Synthetic Data" icon={Database} onClick={() => setActiveTab('synthetic-data')} />
                <TabButton active={activeTab === 'input'} label="Input Files" icon={Folder} onClick={() => setActiveTab('input')} />
                <TabButton active={activeTab === 'output'} label="Output Files" icon={Folder} onClick={() => setActiveTab('output')} />
                <TabButton active={activeTab === 'report'} label="Report" icon={BarChart3} onClick={() => setActiveTab('report')} />
                <TabButton active={activeTab === 'testing'} label="Testing" icon={TestTube2} onClick={() => setActiveTab('testing')} />
                <TabButton active={activeTab === 'compare'} label="Compare" icon={ArrowLeftRight} onClick={() => setActiveTab('compare')} />
                <TabButton active={activeTab === 'ide'} label="IDE / Runner" icon={Play} onClick={() => setActiveTab('ide')} />
              </div>

              {/* Content Area */}
              <div className="flex-1 flex overflow-hidden">
                {/* Element List (Left Sub-panel) */}
                <div className="w-64 border-r bg-white overflow-y-auto">
                  <div className="p-3 border-b bg-gray-50">
                    <p className="text-[10px] font-bold text-gray-500 uppercase tracking-widest">Source Elements</p>
                  </div>
                  {elements.map(e => (
                    <div key={e.id} className="group relative">
                      <button
                        onClick={() => setActiveElement(e)}
                        className={cn(
                          "w-full text-left p-4 border-b hover:bg-gray-50 transition-all",
                          activeElement?.id === e.id ? "bg-blue-50/50 border-l-4 border-blue-600" : ""
                        )}
                      >
                        <div className="flex items-start justify-between">
                          <div className="min-w-0 pr-6">
                            <p className="text-sm font-semibold truncate text-gray-800">{e.name}</p>
                            <p className="text-[10px] text-gray-500 mt-1">{new Date(e.createdAt).toLocaleDateString()}</p>
                          </div>
                          {e.status === 'Completed' ? (
                            <CheckCircle className="w-4 h-4 text-green-500 flex-shrink-0" />
                          ) : e.status === 'Processing' ? (
                            <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-blue-600"></div>
                          ) : (
                            <div className="w-2 h-2 rounded-full bg-gray-300 mt-1.5"></div>
                          )}
                        </div>
                      </button>
                      <button 
                        onClick={(evt) => {
                          evt.stopPropagation();
                          setElementToDelete(e);
                        }}
                        className="absolute right-2 top-4 p-1 text-gray-400 hover:text-red-600 opacity-0 group-hover:opacity-100 transition-all"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  ))}
                </div>

                {/* Main Editor/Viewer */}
                <div className="flex-1 bg-white overflow-hidden flex flex-col">
                  {activeTab === 'ide' ? (
                    <div className="flex-1 overflow-hidden">
                      <IDERunner />
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
                                  <span className="text-xs font-bold text-gray-500 uppercase tracking-wider flex items-center gap-2">
                                    <FileCode className="w-3 h-3" />
                                    COBOL Source: {activeElement.name}
                                  </span>
                                  <button 
                                    onClick={() => setIsAddingElement(true)}
                                    className="flex items-center gap-1.5 px-2 py-1 bg-blue-600 text-white rounded text-[10px] font-bold hover:bg-blue-700 transition-all shadow-sm"
                                  >
                                    <Plus className="w-3 h-3" />
                                    Add COBOL
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
                                  {activeElement.content}
                                </pre>
                              )}
                            </div>
                          )}
                          {activeTab === 'destination' && (
                            <div className="space-y-4 flex flex-col h-full">
                              <div className="flex items-center justify-between bg-gray-50 p-2 rounded border">
                                <span className="text-xs font-bold text-gray-500 uppercase tracking-wider flex items-center gap-2">
                                  <Code2 className="w-3 h-3 text-blue-600" />
                                  {activeProject.targetLanguage.toUpperCase()} Output: {activeElement.name.split('.')[0]}.{activeProject.targetLanguage === 'Java' ? 'java' : 'py'}
                                </span>
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
                              <h3 className="text-lg font-bold flex items-center gap-2">
                                <BarChart3 className="w-5 h-5 text-blue-600" />
                                Modernization Report
                              </h3>
                              {report ? (
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
                                      {Math.round((report.convertedLines / report.totalLines) * 100)}%
                                    </p>
                                  </div>
                                </div>
                              ) : (
                                <div className="p-12 text-center text-gray-400 border rounded-xl border-dashed">
                                  <p>No report available yet.</p>
                                </div>
                              )}
                            </div>
                          )}
                          {activeTab === 'input' && (
                            <div className="space-y-4">
                              <h3 className="text-lg font-bold">Input Files Repository</h3>
                              <div className="bg-gray-50 p-4 rounded-lg border">
                                <div className="flex items-center gap-2 text-sm text-gray-600 mb-4">
                                  <Folder className="w-4 h-4" />
                                  <span>/repository/{activeProject.name}/input/{activeElement.name}/</span>
                                </div>
                                <div className="space-y-2">
                                  {inputFiles.length > 0 ? inputFiles.map(file => (
                                    <div key={file.id} className="flex items-center justify-between p-3 bg-white rounded border hover:shadow-sm transition-all group">
                                      <div className="flex items-center gap-3">
                                        <Database className="w-4 h-4 text-blue-500" />
                                        <div className="flex flex-col">
                                          <span className="text-sm font-medium">{file.name}</span>
                                          <span className="text-[10px] text-gray-400">{file.path}</span>
                                        </div>
                                      </div>
                                      <div className="flex items-center gap-2">
                                        <span className="text-xs text-gray-400 mr-2">{(file.content?.length / 1024).toFixed(1)} KB</span>
                                        <button 
                                          onClick={() => handleEditInputFile(file)}
                                          className="p-1.5 text-gray-400 hover:text-blue-600 hover:bg-blue-50 rounded transition-all"
                                          title="Edit file"
                                        >
                                          <Edit className="w-3.5 h-3.5" />
                                        </button>
                                        <button 
                                          onClick={() => handleMoveToOutput(file)}
                                          className="p-1.5 text-gray-400 hover:text-amber-600 hover:bg-amber-50 rounded transition-all"
                                          title="Move to Output"
                                        >
                                          <ArrowRight className="w-3.5 h-3.5" />
                                        </button>
                                        <button 
                                          onClick={() => handleDeleteInputFile(file.id)}
                                          className="p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded transition-all"
                                          title="Delete file"
                                        >
                                          <Trash2 className="w-3.5 h-3.5" />
                                        </button>
                                      </div>
                                    </div>
                                  )) : (
                                    <div className="p-8 text-center text-gray-400 border rounded-lg border-dashed">
                                      No input files found. Use the Synthetic Data tab to generate some.
                                    </div>
                                  )}
                                </div>
                              </div>
                            </div>
                          )}
                          {activeTab === 'output' && (
                            <div className="space-y-4">
                              <div className="flex items-center justify-between">
                                <h3 className="text-lg font-bold">Output Files Repository</h3>
                                {isEditingOutputFile && (
                                  <div className="flex items-center gap-2">
                                    <button 
                                      onClick={() => setIsEditingOutputFile(false)}
                                      className="px-3 py-1.5 text-xs font-bold text-gray-500 hover:text-gray-700"
                                    >
                                      Cancel
                                    </button>
                                    <button 
                                      onClick={handleUpdateOutputFile}
                                      className="flex items-center gap-2 px-3 py-1.5 bg-blue-600 text-white rounded text-xs font-bold hover:bg-blue-700"
                                    >
                                      <Save className="w-3 h-3" />
                                      Save Changes
                                    </button>
                                  </div>
                                )}
                              </div>

                              {isEditingOutputFile ? (
                                <div className="flex flex-col border rounded-xl overflow-hidden h-[500px]">
                                  <div className="bg-gray-100 p-3 border-b flex justify-between items-center">
                                    <div className="flex items-center gap-2">
                                      <Edit3 className="w-4 h-4 text-blue-600" />
                                      <span className="text-sm font-bold text-gray-700">Editing: {selectedOutputFile?.name}</span>
                                    </div>
                                    <span className="text-[10px] font-mono text-gray-400">{selectedOutputFile?.path}</span>
                                  </div>
                                  <textarea
                                    value={editingOutputFileContent}
                                    onChange={(e) => setEditingOutputFileContent(e.target.value)}
                                    className="flex-1 p-4 font-mono text-xs bg-gray-900 text-green-400 outline-none resize-none leading-relaxed"
                                  />
                                </div>
                              ) : (
                                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                                  <div className="bg-gray-50 p-4 rounded-lg border">
                                    <p className="text-xs font-bold text-gray-500 mb-3 uppercase tracking-wider">COBOL Output</p>
                                    <div className="space-y-2">
                                      {outputFiles.filter(f => f.type === 'Source').length > 0 ? outputFiles.filter(f => f.type === 'Source').map(file => (
                                        <div key={file.id} className="flex items-center justify-between p-3 bg-white rounded border hover:shadow-sm transition-all group">
                                          <div className="flex items-center gap-3">
                                            <Folder className="w-4 h-4 text-amber-500" />
                                            <div className="flex flex-col">
                                              <span className="text-sm font-medium">{file.name}</span>
                                              <span className="text-[10px] text-gray-400">{file.path}</span>
                                            </div>
                                          </div>
                                          <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                                            <button 
                                              onClick={() => handleCopyOutputFile(file)}
                                              className="p-1.5 text-gray-400 hover:text-green-600 hover:bg-green-50 rounded transition-all"
                                              title="Copy to Destination"
                                            >
                                              <Copy className="w-3.5 h-3.5" />
                                            </button>
                                            <button 
                                              onClick={() => handleEditOutputFile(file)}
                                              className="p-1.5 text-gray-400 hover:text-blue-600 hover:bg-blue-50 rounded transition-all"
                                              title="Edit file"
                                            >
                                              <Edit3 className="w-3.5 h-3.5" />
                                            </button>
                                            <button 
                                              onClick={() => handleDeleteOutputFile(file.id)}
                                              className="p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded transition-all"
                                              title="Delete file"
                                            >
                                              <Trash2 className="w-3.5 h-3.5" />
                                            </button>
                                          </div>
                                        </div>
                                      )) : (
                                        <div className="p-4 text-center text-xs text-gray-400 italic">No legacy output files</div>
                                      )}
                                    </div>
                                  </div>
                                  <div className="bg-blue-50/30 p-4 rounded-lg border border-blue-100">
                                    <p className="text-xs font-bold text-blue-600 mb-3 uppercase tracking-wider">Destination Output</p>
                                    <div className="space-y-2">
                                      {outputFiles.filter(f => f.type === 'Destination').length > 0 ? outputFiles.filter(f => f.type === 'Destination').map(file => (
                                        <div key={file.id} className="flex items-center justify-between p-3 bg-white rounded border hover:shadow-sm transition-all group">
                                          <div className="flex items-center gap-3">
                                            <FileCode className="w-4 h-4 text-blue-500" />
                                            <div className="flex flex-col">
                                              <span className="text-sm font-medium">{file.name}</span>
                                              <span className="text-[10px] text-gray-400">{file.path}</span>
                                            </div>
                                          </div>
                                          <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                                            <button 
                                              onClick={() => handleEditOutputFile(file)}
                                              className="p-1.5 text-gray-400 hover:text-blue-600 hover:bg-blue-50 rounded transition-all"
                                              title="Edit file"
                                            >
                                              <Edit3 className="w-3.5 h-3.5" />
                                            </button>
                                            <button 
                                              onClick={() => handleDeleteOutputFile(file.id)}
                                              className="p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded transition-all"
                                              title="Delete file"
                                            >
                                              <Trash2 className="w-3.5 h-3.5" />
                                            </button>
                                          </div>
                                        </div>
                                      )) : (
                                        <div className="p-4 text-center text-xs text-blue-400 italic">No modernized output files</div>
                                      )}
                                    </div>
                                  </div>
                                </div>
                              )}
                            </div>
                          )}
                          {activeTab === 'testing' && (
                            <div className="space-y-6 h-full flex flex-col">
                              <div className="flex items-center justify-between">
                                <div>
                                  <h3 className="text-lg font-bold flex items-center gap-2">
                                    <TestTube2 className="w-5 h-5 text-blue-600" />
                                    Automated Testing Module
                                  </h3>
                                  <p className="text-xs text-gray-500">Generate and execute unit tests for the modernized code.</p>
                                </div>
                                <div className="flex items-center gap-2">
                                  <button 
                                    onClick={handleClearTestResults}
                                    disabled={isRunningTest !== null || testCases.length === 0}
                                    className="px-3 py-2 text-gray-600 border rounded-md text-xs font-bold hover:bg-gray-50 disabled:opacity-50 transition-all"
                                  >
                                    Clear Results
                                  </button>
                                  <button 
                                    onClick={handleRunAllTests}
                                    disabled={isRunningTest !== null || testCases.length === 0}
                                    className="flex items-center gap-2 px-3 py-2 bg-green-600 text-white rounded-md text-xs font-bold hover:bg-green-700 disabled:opacity-50 transition-all"
                                  >
                                    <Play className="w-3.5 h-3.5" />
                                    Run All Tests
                                  </button>
                                  <button 
                                    onClick={handleCreateComparisonTest}
                                    className="flex items-center gap-2 px-3 py-2 bg-amber-600 text-white rounded-md text-xs font-bold hover:bg-amber-700 transition-all shadow-sm"
                                    title="Create a test case to compare Source and Destination output files"
                                  >
                                    <ArrowLeftRight className="w-3.5 h-3.5" />
                                    Add Comparison Test
                                  </button>
                                  <button 
                                    onClick={handleGenerateTestCase}
                                    disabled={isGeneratingTest || !activeElement.convertedContent}
                                    className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-md text-sm font-bold hover:bg-blue-700 disabled:opacity-50 transition-all shadow-sm"
                                  >
                                    {isGeneratingTest ? <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white"></div> : <Plus className="w-4 h-4" />}
                                    Generate Test Case
                                  </button>
                                </div>
                              </div>

                              <div className="flex-1 overflow-auto">
                                {testCases.length > 0 ? (
                                  <div className="space-y-4">
                                    {testCases.map(tc => (
                                      <div key={tc.id} className="bg-white border rounded-xl overflow-hidden shadow-sm hover:shadow-md transition-all">
                                        <div className="p-4 border-b bg-gray-50 flex items-center justify-between">
                                          <div className="flex items-center gap-3">
                                            <div className={cn(
                                              "w-2 h-2 rounded-full",
                                              tc.status === 'Passed' ? "bg-green-500" : tc.status === 'Failed' ? "bg-red-500" : "bg-gray-300"
                                            )} />
                                            <h4 className="font-bold text-gray-800">{tc.name}</h4>
                                            <span className={cn(
                                              "text-[10px] font-bold px-2 py-0.5 rounded-full uppercase tracking-wider",
                                              tc.type === 'Comparison' ? "bg-amber-100 text-amber-700" : "bg-blue-100 text-blue-700"
                                            )}>
                                              {tc.type || 'Execution'}
                                            </span>
                                            <span className={cn(
                                              "text-[10px] font-bold px-2 py-0.5 rounded-full uppercase tracking-wider",
                                              tc.status === 'Passed' ? "bg-green-100 text-green-700" : tc.status === 'Failed' ? "bg-red-100 text-red-700" : "bg-gray-100 text-gray-600"
                                            )}>
                                              {tc.status}
                                            </span>
                                          </div>
                                          <div className="flex items-center gap-2">
                                            <button 
                                              onClick={() => handleRunTest(tc)}
                                              disabled={isRunningTest === tc.id}
                                              className="flex items-center gap-1.5 px-3 py-1 bg-blue-600 text-white rounded text-[10px] font-bold hover:bg-blue-700 disabled:opacity-50"
                                            >
                                              {isRunningTest === tc.id ? <div className="animate-spin rounded-full h-3 w-3 border-b-2 border-white"></div> : <Play className="w-3 h-3" />}
                                              Run Test
                                            </button>
                                            <button 
                                              onClick={() => handleDeleteTestCase(tc.id)}
                                              className="p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded transition-all"
                                            >
                                              <Trash2 className="w-3.5 h-3.5" />
                                            </button>
                                          </div>
                                        </div>
                                        <div className="p-4 grid grid-cols-1 md:grid-cols-2 gap-4">
                                          <div className="space-y-2">
                                            <p className="text-[10px] font-bold text-gray-400 uppercase tracking-widest">Description</p>
                                            <p className="text-xs text-gray-600">{tc.description}</p>
                                            
                                            <p className="text-[10px] font-bold text-gray-400 uppercase tracking-widest mt-4">
                                              {tc.type === 'Comparison' ? 'Source File' : 'Input Data'}
                                            </p>
                                            <pre className="p-2 bg-gray-900 text-green-400 rounded text-[10px] font-mono overflow-x-auto">
                                              {tc.type === 'Comparison' ? 
                                                outputFiles.find(f => f.id === tc.inputData)?.name || tc.inputData : 
                                                (typeof tc.inputData === 'object' ? JSON.stringify(tc.inputData, null, 2) : tc.inputData)
                                              }
                                            </pre>
                                          </div>
                                          <div className="space-y-2">
                                            <p className="text-[10px] font-bold text-gray-400 uppercase tracking-widest">
                                              {tc.type === 'Comparison' ? 'Destination File' : 'Expected Output'}
                                            </p>
                                            <pre className="p-2 bg-gray-50 border rounded text-[10px] font-mono overflow-x-auto text-gray-600">
                                              {tc.type === 'Comparison' ? 
                                                outputFiles.find(f => f.id === tc.expectedOutput)?.name || tc.expectedOutput : 
                                                (typeof tc.expectedOutput === 'object' ? JSON.stringify(tc.expectedOutput, null, 2) : tc.expectedOutput)
                                              }
                                            </pre>

                                            {(tc.actualOutput || tc.logs) && (
                                              <>
                                                <p className="text-[10px] font-bold text-gray-400 uppercase tracking-widest mt-4">Result / Logs</p>
                                                <div className={cn(
                                                  "p-2 rounded text-[10px] font-mono overflow-x-auto",
                                                  tc.status === 'Passed' ? "bg-green-50 text-green-700 border border-green-100" : "bg-red-50 text-red-700 border border-red-100"
                                                )}>
                                                  {tc.logs && <div className="mb-1 font-bold">{typeof tc.logs === 'object' ? JSON.stringify(tc.logs, null, 2) : tc.logs}</div>}
                                                  {tc.actualOutput && <div className="opacity-70">{typeof tc.actualOutput === 'object' ? JSON.stringify(tc.actualOutput, null, 2) : tc.actualOutput}</div>}
                                                </div>
                                              </>
                                            )}
                                          </div>
                                        </div>
                                      </div>
                                    ))}
                                  </div>
                                ) : (
                                  <div className="h-full flex flex-col items-center justify-center text-gray-400 border-2 border-dashed rounded-xl p-12">
                                    <TestTube2 className="w-16 h-16 mb-4 opacity-10" />
                                    <p className="text-lg font-medium">No test cases defined</p>
                                    <p className="text-sm max-w-xs text-center mt-2">Click "Generate Test Case" to automatically create tests based on your modernized code.</p>
                                  </div>
                                )}
                              </div>
                            </div>
                          )}
                          {activeTab === 'compare' && (
                            <div className="h-full flex flex-col space-y-4">
                              <div className="bg-gray-50 p-4 rounded-xl border space-y-4">
                                <div className="flex items-center justify-between">
                                  <div className="flex items-center gap-4 flex-1">
                                    <div className="flex flex-col gap-1 flex-1">
                                      <label className="text-[10px] font-bold text-gray-400 uppercase tracking-wider">Source Output (COBOL)</label>
                                      <select 
                                        value={selectedSourceFileId}
                                        onChange={(e) => setSelectedSourceFileId(e.target.value)}
                                        className="text-xs border rounded p-2 bg-white w-full"
                                      >
                                        <option value="">Select Source File</option>
                                        {outputFiles.filter(f => f.type === 'Source').map(f => (
                                          <option key={f.id} value={f.id}>{f.name} ({f.path})</option>
                                        ))}
                                      </select>
                                    </div>
                                    <div className="flex items-center justify-center text-gray-300">
                                      <ArrowLeftRight className="w-4 h-4" />
                                    </div>
                                    <div className="flex flex-col gap-1 flex-1">
                                      <label className="text-[10px] font-bold text-gray-400 uppercase tracking-wider">Destination Output ({activeProject?.targetLanguage})</label>
                                      <select 
                                        value={selectedDestinationFileId}
                                        onChange={(e) => setSelectedDestinationFileId(e.target.value)}
                                        className="text-xs border rounded p-2 bg-white w-full"
                                      >
                                        <option value="">Select Destination File</option>
                                        {outputFiles.filter(f => f.type === 'Destination').map(f => (
                                          <option key={f.id} value={f.id}>{f.name} ({f.path})</option>
                                        ))}
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
                                
                                <div className="flex items-center gap-6 pt-2 border-t border-gray-200">
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

                              {comparisonSummary && (
                                <div className="grid grid-cols-4 gap-4">
                                  <div className="bg-white p-3 rounded-lg border flex flex-col items-center">
                                    <span className="text-[10px] font-bold text-gray-400 uppercase">Total Lines</span>
                                    <span className="text-xl font-bold text-gray-900">{comparisonSummary.total}</span>
                                  </div>
                                  <div className="bg-green-50 p-3 rounded-lg border border-green-100 flex flex-col items-center">
                                    <span className="text-[10px] font-bold text-green-600 uppercase">Exact Matches</span>
                                    <span className="text-xl font-bold text-green-700">{comparisonSummary.matches}</span>
                                  </div>
                                  <div className="bg-amber-50 p-3 rounded-lg border border-amber-100 flex flex-col items-center">
                                    <span className="text-[10px] font-bold text-amber-600 uppercase">Partial Matches (&gt;50%)</span>
                                    <span className="text-xl font-bold text-amber-700">{comparisonSummary.partials}</span>
                                  </div>
                                  <div className="bg-red-50 p-3 rounded-lg border border-red-100 flex flex-col items-center">
                                    <span className="text-[10px] font-bold text-red-600 uppercase">Mismatches</span>
                                    <span className="text-xl font-bold text-red-700">{comparisonSummary.mismatches}</span>
                                  </div>
                                </div>
                              )}

                              <div className="flex-1 overflow-hidden flex flex-col border rounded-xl bg-white">
                                <div className="grid grid-cols-2 bg-gray-100 border-b">
                                  <div className="p-2 text-[10px] font-bold uppercase text-gray-500 border-r">COBOL Output Reference</div>
                                  <div className="p-2 text-[10px] font-bold uppercase text-blue-600">Modernized Output Result</div>
                                </div>
                                <div className="flex-1 overflow-auto font-mono text-xs">
                                  {comparisonResult ? (
                                    <div className="divide-y">
                                      {comparisonResult.map((line, idx) => (
                                        <div key={idx} className="grid grid-cols-2 hover:bg-gray-50/50 transition-colors">
                                          <div className={cn(
                                            "p-2 border-r break-all whitespace-pre-wrap relative",
                                            line.isMatch ? "bg-green-100 text-green-900" : 
                                            line.similarity > 0.5 ? "bg-amber-100 text-amber-900" :
                                            "bg-red-100 text-red-900"
                                          )}>
                                            <span className="inline-block w-6 text-[8px] text-gray-400 select-none">{idx + 1}</span>
                                            {line.sourceLine || <span className="opacity-20 italic">empty</span>}
                                            {!line.isMatch && line.similarity > 0.5 && (
                                              <span className="absolute top-1 right-1 text-[8px] font-bold text-amber-600 bg-white px-1 rounded border border-amber-200">
                                                {Math.round(line.similarity * 100)}% Match
                                              </span>
                                            )}
                                          </div>
                                          <div className={cn(
                                            "p-2 break-all whitespace-pre-wrap relative",
                                            line.isMatch ? "bg-green-100 text-green-900" : 
                                            line.similarity > 0.5 ? "bg-amber-100 text-amber-900" :
                                            "bg-red-100 text-red-900"
                                          )}>
                                            <span className="inline-block w-6 text-[8px] text-gray-400 select-none">{idx + 1}</span>
                                            {line.destLine || <span className="opacity-20 italic">empty</span>}
                                            {!line.isMatch && line.similarity > 0.5 && (
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
                  <h2 className="text-2xl font-bold text-gray-800 mb-4">Welcome to ATLAS</h2>
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
                    onChange={handleFileUpload}
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
      </AnimatePresence>
    </div>
  );
}
