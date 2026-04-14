import { useState, useRef, useEffect } from 'react';
import { Upload, Image as ImageIcon, ShieldCheck, ShieldAlert, FileSearch, Info, ChevronRight, Loader2, AlertTriangle, LogIn, LogOut, History, Trash2 } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { GoogleGenAI, Type } from '@google/genai';
import ReactMarkdown from 'react-markdown';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import { auth, db, signInWithGoogle, logOut } from './firebase';
import { onAuthStateChanged, User } from 'firebase/auth';
import { collection, addDoc, query, where, onSnapshot, orderBy, serverTimestamp, deleteDoc, doc } from 'firebase/firestore';

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: any;
}

function handleFirestoreError(error: unknown, operationType: OperationType, path: string | null) {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
      tenantId: auth.currentUser?.tenantId,
      providerInfo: auth.currentUser?.providerData.map(provider => ({
        providerId: provider.providerId,
        displayName: provider.displayName,
        email: provider.email,
        photoUrl: provider.photoURL
      })) || []
    },
    operationType,
    path
  }
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

const ROADMAP_MARKDOWN = `
# Roteiro Técnico: AI Authenticator

Este guia detalha a arquitetura e os componentes necessários para construir o **AI Authenticator**, um aplicativo projetado para identificar fotos e vídeos gerados por Inteligência Artificial.

## 1. Análise de Metadados

A primeira linha de defesa contra mídias sintéticas é a análise dos dados embutidos no arquivo.

*   **Extração EXIF:** O aplicativo deve utilizar bibliotecas (como \`exiftool\` no backend ou \`exifreader\` no frontend) para extrair metadados tradicionais. Imagens geradas por IA frequentemente carecem de dados de câmera consistentes (ex: modelo da lente, tempo de exposição, ISO) ou apresentam metadados limpos/ausentes.
*   **Padrão C2PA (Content Credentials):** A Coalition for Content Provenance and Authenticity (C2PA) estabelece um padrão para procedência de mídia. O app deve integrar o SDK de código aberto do C2PA (ex: \`c2pa-node\`) para ler as credenciais de conteúdo. Se a imagem foi gerada por ferramentas como DALL-E 3 ou Adobe Firefly, ela conterá uma assinatura criptográfica indicando sua origem sintética.

## 2. Análise Visual

Modelos generativos, apesar de avançados, ainda deixam "impressões digitais" visuais. O modelo de visão computacional do app deve procurar por:

*   **Distorções Anatômicas:** Assimetrias faciais, pupilas irregulares, dentes fundidos ou em número incorreto, e membros/dedos anômalos.
*   **Inconsistências Físicas:** Iluminação impossível (sombras que não correspondem às fontes de luz), reflexos incorretos em espelhos ou olhos, e geometria de objetos distorcida.
*   **Artefatos de Textura e Ruído:** Suavização excessiva (efeito "plástico" na pele), padrões de ruído artificiais no fundo, e bordas borradas onde objetos se encontram.
*   **Texto e Padrões:** Texto ininteligível ou caracteres alienígenas em placas/roupas, e repetições de padrões que quebram a lógica espacial.

## 3. Tecnologia Google: SynthID

O SynthID é a tecnologia do Google para adicionar marcas d'água digitais imperceptíveis a imagens, áudios, textos e vídeos gerados por IA.

*   **Integração:** O AI Authenticator pode integrar a verificação do SynthID através das APIs do Google Cloud (especificamente no Vertex AI).
*   **Funcionamento:** O SynthID incorpora a marca d'água diretamente nos pixels da imagem, tornando-a resistente a edições, cortes ou compressões. O backend do app envia a imagem para a API de detecção do SynthID, que retorna uma pontuação de confiança indicando se a marca d'água do Google foi detectada.

## 4. Interface do Usuário (UI)

A interface deve ser intuitiva e transparente, focada em fornecer resultados claros.

*   **Upload:** Uma área de "Drag & Drop" simples e proeminente.
*   **Processamento:** Indicadores visuais de que a imagem está sendo analisada em múltiplas camadas (Metadados, Visual, SynthID).
*   **Resultado (Nota de Probabilidade):** Um medidor visual (0% a 100%) indicando a probabilidade de ser IA.
    *   *Verde (0-30%):* Alta probabilidade de ser real.
    *   *Amarelo (31-70%):* Inconclusivo / Sinais mistos.
    *   *Vermelho (71-100%):* Alta probabilidade de ser IA.
*   **Justificativa Técnica:** Um painel detalhando os artefatos encontrados (ex: "Anomalia detectada na textura do fundo") e os resultados da análise de metadados.

## 5. Fluxo de Backend

Para processar arquivos de forma escalável e segura, a arquitetura ideal na nuvem seria:

1.  **Armazenamento:** O frontend faz o upload do arquivo diretamente para um bucket do **Google Cloud Storage** usando URLs assinadas.
2.  **Processamento Assíncrono:** O upload aciona uma **Cloud Function** ou um serviço no **Cloud Run**.
3.  **Análise de Metadados:** O serviço extrai EXIF e valida assinaturas C2PA.
4.  **Análise Visual e SynthID:**
    *   O serviço chama a API do **Gemini 1.5 Pro** (ou Gemini 3.1 Pro) no Vertex AI, passando a imagem e um prompt rigoroso para análise de artefatos visuais.
    *   Paralelamente, chama a API de detecção do **SynthID** para verificar marcas d'água.
5.  **Agregação:** Os resultados são combinados em uma "Nota de Probabilidade" final e salvos no **Firestore**.
6.  **Retorno:** O frontend escuta as mudanças no Firestore (via WebSockets/onSnapshot) e atualiza a UI em tempo real.
`;

interface AnalysisResult {
  probability: number;
  justification: string;
  artifacts: string[];
}

interface SavedAnalysis extends AnalysisResult {
  id: string;
  fileName: string;
  createdAt: any;
}

export default function App() {
  const [activeTab, setActiveTab] = useState<'analyzer' | 'roadmap' | 'history'>('analyzer');
  const [user, setUser] = useState<User | null>(null);
  const [history, setHistory] = useState<SavedAnalysis[]>([]);
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [result, setResult] = useState<AnalysisResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (currentUser) => {
      setUser(currentUser);
    });
    return () => unsubscribe();
  }, []);

  useEffect(() => {
    if (!user) {
      setHistory([]);
      return;
    }
    const q = query(
      collection(db, 'analyses'),
      where('uid', '==', user.uid),
      orderBy('createdAt', 'desc')
    );
    const unsubscribe = onSnapshot(q, (snapshot) => {
      const analyses: SavedAnalysis[] = [];
      snapshot.forEach((doc) => {
        analyses.push({ id: doc.id, ...doc.data() } as SavedAnalysis);
      });
      setHistory(analyses);
    }, (error) => {
      handleFirestoreError(error, OperationType.LIST, 'analyses');
    });
    return () => unsubscribe();
  }, [user]);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFile = e.target.files?.[0];
    if (selectedFile) {
      processFile(selectedFile);
    }
  };

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    const droppedFile = e.dataTransfer.files?.[0];
    if (droppedFile && droppedFile.type.startsWith('image/')) {
      processFile(droppedFile);
    }
  };

  const processFile = (selectedFile: File) => {
    setFile(selectedFile);
    setResult(null);
    setError(null);
    const url = URL.createObjectURL(selectedFile);
    setPreviewUrl(url);
  };

  const analyzeImage = async () => {
    if (!file) return;

    setIsAnalyzing(true);
    setError(null);

    try {
      // Convert file to base64
      const reader = new FileReader();
      const base64Promise = new Promise<string>((resolve, reject) => {
        reader.onload = () => {
          const result = reader.result as string;
          // Remove the data:image/jpeg;base64, part
          const base64Data = result.split(',')[1];
          resolve(base64Data);
        };
        reader.onerror = reject;
      });
      reader.readAsDataURL(file);
      const base64Data = await base64Promise;

      // Initialize Gemini API
      const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

      const response = await ai.models.generateContent({
        model: 'gemini-3.1-pro-preview',
        contents: [
          {
            inlineData: {
              data: base64Data,
              mimeType: file.type,
            },
          },
          {
            text: "Você é um especialista em visão computacional e detecção de IA. Analise esta imagem minuciosamente em busca de sinais de geração por IA. Procure por distorções anatômicas, padrões de ruído artificiais, inconsistências em reflexos e sombras, ou suavização excessiva de texturas. Com base apenas nos elementos visuais, qual a probabilidade desta imagem ser sintética e por quê?",
          },
        ],
        config: {
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              probability: {
                type: Type.NUMBER,
                description: "Probabilidade de 0 a 100 da imagem ser gerada por IA.",
              },
              justification: {
                type: Type.STRING,
                description: "Justificativa técnica detalhada.",
              },
              artifacts: {
                type: Type.ARRAY,
                items: { type: Type.STRING },
                description: "Lista de artefatos visuais encontrados (ex: 'Distorção nos dedos', 'Iluminação inconsistente').",
              },
            },
            required: ["probability", "justification", "artifacts"],
          },
        },
      });

      const jsonStr = response.text?.trim();
      if (jsonStr) {
        const parsedResult = JSON.parse(jsonStr) as AnalysisResult;
        setResult(parsedResult);
        
        if (user) {
          try {
            await addDoc(collection(db, 'analyses'), {
              uid: user.uid,
              fileName: file.name,
              probability: parsedResult.probability,
              justification: parsedResult.justification,
              artifacts: parsedResult.artifacts,
              createdAt: serverTimestamp()
            });
          } catch (error) {
            handleFirestoreError(error, OperationType.CREATE, 'analyses');
          }
        }
      } else {
        throw new Error("Resposta vazia do modelo.");
      }
    } catch (err) {
      console.error(err);
      setError("Ocorreu um erro ao analisar a imagem. Verifique o console para mais detalhes.");
    } finally {
      setIsAnalyzing(false);
    }
  };

  const deleteAnalysis = async (id: string) => {
    try {
      await deleteDoc(doc(db, 'analyses', id));
    } catch (error) {
      handleFirestoreError(error, OperationType.DELETE, `analyses/${id}`);
    }
  };

  const getScoreColor = (prob: number) => {
    if (prob <= 30) return 'text-emerald-500';
    if (prob <= 70) return 'text-amber-500';
    return 'text-rose-500';
  };

  const getScoreBg = (prob: number) => {
    if (prob <= 30) return 'bg-emerald-500/10 border-emerald-500/20';
    if (prob <= 70) return 'bg-amber-500/10 border-amber-500/20';
    return 'bg-rose-500/10 border-rose-500/20';
  };

  return (
    <div className="min-h-screen bg-neutral-950 text-neutral-50 font-sans selection:bg-indigo-500/30">
      {/* Header */}
      <header className="border-b border-neutral-800 bg-neutral-900/50 backdrop-blur-md sticky top-0 z-10">
        <div className="max-w-5xl mx-auto px-6 h-16 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-lg bg-indigo-500 flex items-center justify-center">
              <ShieldCheck className="w-5 h-5 text-white" />
            </div>
            <h1 className="text-xl font-semibold tracking-tight">AI Authenticator</h1>
          </div>
          <nav className="flex items-center gap-1 bg-neutral-800/50 p-1 rounded-lg border border-neutral-700/50 hidden md:flex">
            <button
              onClick={() => setActiveTab('analyzer')}
              className={cn(
                "px-4 py-1.5 text-sm font-medium rounded-md transition-all",
                activeTab === 'analyzer' 
                  ? "bg-neutral-700 text-white shadow-sm" 
                  : "text-neutral-400 hover:text-neutral-200 hover:bg-neutral-700/50"
              )}
            >
              Analisador
            </button>
            {user && (
              <button
                onClick={() => setActiveTab('history')}
                className={cn(
                  "px-4 py-1.5 text-sm font-medium rounded-md transition-all",
                  activeTab === 'history' 
                    ? "bg-neutral-700 text-white shadow-sm" 
                    : "text-neutral-400 hover:text-neutral-200 hover:bg-neutral-700/50"
                )}
              >
                Histórico
              </button>
            )}
            <button
              onClick={() => setActiveTab('roadmap')}
              className={cn(
                "px-4 py-1.5 text-sm font-medium rounded-md transition-all",
                activeTab === 'roadmap' 
                  ? "bg-neutral-700 text-white shadow-sm" 
                  : "text-neutral-400 hover:text-neutral-200 hover:bg-neutral-700/50"
              )}
            >
              Roteiro Técnico
            </button>
          </nav>
          <div className="flex items-center">
            {user ? (
              <div className="flex items-center gap-3">
                <span className="text-sm text-neutral-400 hidden sm:inline-block">{user.email}</span>
                <button onClick={logOut} className="p-2 text-neutral-400 hover:text-white hover:bg-neutral-800 rounded-lg transition-colors" title="Sair">
                  <LogOut className="w-5 h-5" />
                </button>
              </div>
            ) : (
              <button onClick={signInWithGoogle} className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-500 rounded-lg transition-colors">
                <LogIn className="w-4 h-4" />
                Entrar
              </button>
            )}
          </div>
        </div>
      </header>

      {/* Mobile Nav */}
      <div className="md:hidden border-b border-neutral-800 bg-neutral-900/50 px-4 py-2 flex gap-2 overflow-x-auto">
        <button
          onClick={() => setActiveTab('analyzer')}
          className={cn(
            "px-4 py-1.5 text-sm font-medium rounded-md transition-all whitespace-nowrap",
            activeTab === 'analyzer' 
              ? "bg-neutral-700 text-white shadow-sm" 
              : "text-neutral-400 hover:text-neutral-200 hover:bg-neutral-700/50"
          )}
        >
          Analisador
        </button>
        {user && (
          <button
            onClick={() => setActiveTab('history')}
            className={cn(
              "px-4 py-1.5 text-sm font-medium rounded-md transition-all whitespace-nowrap",
              activeTab === 'history' 
                ? "bg-neutral-700 text-white shadow-sm" 
                : "text-neutral-400 hover:text-neutral-200 hover:bg-neutral-700/50"
            )}
          >
            Histórico
          </button>
        )}
        <button
          onClick={() => setActiveTab('roadmap')}
          className={cn(
            "px-4 py-1.5 text-sm font-medium rounded-md transition-all whitespace-nowrap",
            activeTab === 'roadmap' 
              ? "bg-neutral-700 text-white shadow-sm" 
              : "text-neutral-400 hover:text-neutral-200 hover:bg-neutral-700/50"
          )}
        >
          Roteiro Técnico
        </button>
      </div>

      {/* Main Content */}
      <main className="max-w-5xl mx-auto px-6 py-12">
        <AnimatePresence mode="wait">
          {activeTab === 'analyzer' ? (
            <motion.div
              key="analyzer"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              className="grid grid-cols-1 lg:grid-cols-2 gap-8"
            >
              {/* Upload Section */}
              <div className="space-y-6">
                <div>
                  <h2 className="text-2xl font-semibold tracking-tight mb-2">Verificação de Mídia</h2>
                  <p className="text-neutral-400 text-sm">
                    Faça o upload de uma imagem para analisar sinais de geração por Inteligência Artificial usando o Gemini 3.1 Pro.
                  </p>
                  {!user && (
                    <div className="mt-4 p-3 rounded-lg bg-indigo-500/10 border border-indigo-500/20 text-sm text-indigo-300 flex items-start gap-2">
                      <Info className="w-4 h-4 shrink-0 mt-0.5" />
                      <p>Faça login para salvar automaticamente o histórico das suas análises.</p>
                    </div>
                  )}
                </div>

                <div
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={handleDrop}
                  className={cn(
                    "border-2 border-dashed rounded-2xl p-8 transition-all flex flex-col items-center justify-center text-center min-h-[300px]",
                    previewUrl 
                      ? "border-neutral-700 bg-neutral-900/30" 
                      : "border-neutral-700 hover:border-indigo-500/50 hover:bg-indigo-500/5 bg-neutral-900/50 cursor-pointer"
                  )}
                  onClick={() => !previewUrl && fileInputRef.current?.click()}
                >
                  {previewUrl ? (
                    <div className="relative w-full h-full flex flex-col items-center">
                      <img 
                        src={previewUrl} 
                        alt="Preview" 
                        className="max-h-[300px] object-contain rounded-lg shadow-lg mb-4"
                      />
                      <div className="flex gap-3">
                        <button
                          onClick={() => {
                            setFile(null);
                            setPreviewUrl(null);
                            setResult(null);
                          }}
                          className="px-4 py-2 text-sm font-medium text-neutral-300 bg-neutral-800 hover:bg-neutral-700 rounded-lg transition-colors"
                        >
                          Trocar Imagem
                        </button>
                        <button
                          onClick={analyzeImage}
                          disabled={isAnalyzing || result !== null}
                          className="px-4 py-2 text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed rounded-lg transition-colors flex items-center gap-2"
                        >
                          {isAnalyzing ? (
                            <>
                              <Loader2 className="w-4 h-4 animate-spin" />
                              Analisando...
                            </>
                          ) : (
                            <>
                              <FileSearch className="w-4 h-4" />
                              Analisar Imagem
                            </>
                          )}
                        </button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <div className="w-16 h-16 rounded-full bg-neutral-800 flex items-center justify-center mb-4">
                        <Upload className="w-8 h-8 text-neutral-400" />
                      </div>
                      <p className="text-neutral-200 font-medium mb-1">Clique ou arraste uma imagem</p>
                      <p className="text-neutral-500 text-sm">Suporta JPG, PNG, WEBP</p>
                    </>
                  )}
                  <input
                    type="file"
                    ref={fileInputRef}
                    onChange={handleFileChange}
                    accept="image/*"
                    className="hidden"
                  />
                </div>
              </div>

              {/* Results Section */}
              <div className="space-y-6">
                {error && (
                  <div className="p-4 rounded-xl bg-rose-500/10 border border-rose-500/20 flex items-start gap-3">
                    <ShieldAlert className="w-5 h-5 text-rose-500 shrink-0 mt-0.5" />
                    <p className="text-sm text-rose-200">{error}</p>
                  </div>
                )}

                {!result && !isAnalyzing && !error && (
                  <div className="h-full min-h-[300px] rounded-2xl border border-neutral-800 bg-neutral-900/30 flex flex-col items-center justify-center text-center p-8">
                    <ImageIcon className="w-12 h-12 text-neutral-700 mb-4" />
                    <p className="text-neutral-400 text-sm">
                      O resultado da análise aparecerá aqui.
                    </p>
                  </div>
                )}

                {isAnalyzing && (
                  <div className="h-full min-h-[300px] rounded-2xl border border-neutral-800 bg-neutral-900/30 flex flex-col items-center justify-center text-center p-8">
                    <Loader2 className="w-10 h-10 text-indigo-500 animate-spin mb-4" />
                    <p className="text-neutral-300 font-medium animate-pulse">Processando análise visual...</p>
                    <p className="text-neutral-500 text-sm mt-2">Buscando por artefatos e inconsistências.</p>
                  </div>
                )}

                {result && (
                  <motion.div
                    initial={{ opacity: 0, scale: 0.95 }}
                    animate={{ opacity: 1, scale: 1 }}
                    className="space-y-4"
                  >
                    {/* Score Card */}
                    <div className={cn("p-6 rounded-2xl border flex flex-col items-center text-center", getScoreBg(result.probability))}>
                      <p className="text-sm font-medium text-neutral-300 mb-2 uppercase tracking-wider">Probabilidade de IA</p>
                      <div className="flex items-baseline gap-1">
                        <span className={cn("text-6xl font-bold tracking-tighter", getScoreColor(result.probability))}>
                          {result.probability}
                        </span>
                        <span className={cn("text-2xl font-medium", getScoreColor(result.probability))}>%</span>
                      </div>
                      <p className="text-sm text-neutral-400 mt-4 max-w-sm">
                        {result.probability <= 30 && "A imagem apresenta fortes características orgânicas e consistência física."}
                        {result.probability > 30 && result.probability <= 70 && "A imagem possui sinais mistos. Pode ter sofrido edição pesada ou ser uma geração de alta qualidade."}
                        {result.probability > 70 && "Alta probabilidade de geração sintética baseada em artefatos visuais detectados."}
                      </p>
                    </div>

                    {/* Justification */}
                    <div className="p-6 rounded-2xl border border-neutral-800 bg-neutral-900/50">
                      <h3 className="text-sm font-medium text-neutral-300 mb-3 flex items-center gap-2">
                        <Info className="w-4 h-4" />
                        Justificativa Técnica
                      </h3>
                      <p className="text-sm text-neutral-300 leading-relaxed">
                        {result.justification}
                      </p>
                    </div>

                    {/* Artifacts */}
                    {result.artifacts.length > 0 && (
                      <div className="p-6 rounded-2xl border border-neutral-800 bg-neutral-900/50">
                        <h3 className="text-sm font-medium text-neutral-300 mb-3 flex items-center gap-2">
                          <AlertTriangle className="w-4 h-4" />
                          Artefatos Detectados
                        </h3>
                        <ul className="space-y-2">
                          {result.artifacts.map((artifact, idx) => (
                            <li key={idx} className="flex items-start gap-2 text-sm text-neutral-400">
                              <ChevronRight className="w-4 h-4 text-indigo-500 shrink-0 mt-0.5" />
                              <span>{artifact}</span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </motion.div>
                )}
              </div>
            </motion.div>
          ) : activeTab === 'history' ? (
            <motion.div
              key="history"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              className="space-y-6"
            >
              <div className="flex items-center justify-between mb-6">
                <div>
                  <h2 className="text-2xl font-semibold tracking-tight mb-2">Histórico de Análises</h2>
                  <p className="text-neutral-400 text-sm">
                    Suas análises anteriores salvas na nuvem.
                  </p>
                </div>
              </div>
              
              {history.length === 0 ? (
                <div className="p-12 rounded-3xl border border-neutral-800 bg-neutral-900/30 text-center">
                  <History className="w-12 h-12 text-neutral-700 mx-auto mb-4" />
                  <p className="text-neutral-400">Nenhuma análise encontrada.</p>
                </div>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {history.map((item) => (
                    <div key={item.id} className="p-6 rounded-2xl border border-neutral-800 bg-neutral-900/50 flex flex-col">
                      <div className="flex items-start justify-between mb-4">
                        <div className="flex items-center gap-3">
                          <div className={cn("w-12 h-12 rounded-full flex items-center justify-center font-bold text-lg", getScoreBg(item.probability), getScoreColor(item.probability))}>
                            {item.probability}%
                          </div>
                          <div>
                            <p className="font-medium text-neutral-200 truncate max-w-[200px]" title={item.fileName}>{item.fileName}</p>
                            <p className="text-xs text-neutral-500">
                              {item.createdAt?.toDate ? item.createdAt.toDate().toLocaleDateString() : 'Recente'}
                            </p>
                          </div>
                        </div>
                        <button 
                          onClick={() => deleteAnalysis(item.id)}
                          className="p-2 text-neutral-500 hover:text-rose-500 hover:bg-rose-500/10 rounded-lg transition-colors"
                          title="Excluir"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                      <p className="text-sm text-neutral-400 line-clamp-3 mb-4 flex-grow">
                        {item.justification}
                      </p>
                      <div className="flex flex-wrap gap-2 mt-auto">
                        {item.artifacts.slice(0, 2).map((art, idx) => (
                          <span key={idx} className="px-2 py-1 text-xs rounded-md bg-neutral-800 text-neutral-300 truncate max-w-full" title={art}>
                            {art}
                          </span>
                        ))}
                        {item.artifacts.length > 2 && (
                          <span className="px-2 py-1 text-xs rounded-md bg-neutral-800 text-neutral-500">
                            +{item.artifacts.length - 2}
                          </span>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </motion.div>
          ) : (
            <motion.div
              key="roadmap"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              className="prose prose-invert prose-indigo max-w-none"
            >
              <div className="p-8 rounded-3xl border border-neutral-800 bg-neutral-900/30">
                <ReactMarkdown>{ROADMAP_MARKDOWN}</ReactMarkdown>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </main>
    </div>
  );
}
