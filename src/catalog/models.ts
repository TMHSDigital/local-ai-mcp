export interface CatalogModel {
  name: string;
  family: string;
  parameterSize: string;
  approxSizeBytes: number;
  quantization: string;
  tasks: string[];
}

const GB = 1024 * 1024 * 1024;

export const CATALOG: CatalogModel[] = [
  {
    name: "llama3.2:1b",
    family: "llama",
    parameterSize: "1B",
    approxSizeBytes: Math.round(1.3 * GB),
    quantization: "Q4_K_M",
    tasks: ["chat", "general"],
  },
  {
    name: "llama3.2:3b",
    family: "llama",
    parameterSize: "3B",
    approxSizeBytes: Math.round(2.0 * GB),
    quantization: "Q4_K_M",
    tasks: ["chat", "general"],
  },
  {
    name: "llama3.1:8b",
    family: "llama",
    parameterSize: "8B",
    approxSizeBytes: Math.round(4.7 * GB),
    quantization: "Q4_K_M",
    tasks: ["chat", "general", "reasoning"],
  },
  {
    name: "llama3.1:70b",
    family: "llama",
    parameterSize: "70B",
    approxSizeBytes: Math.round(40 * GB),
    quantization: "Q4_K_M",
    tasks: ["chat", "general", "reasoning"],
  },
  {
    name: "llama3.3:70b",
    family: "llama",
    parameterSize: "70B",
    approxSizeBytes: Math.round(40 * GB),
    quantization: "Q4_K_M",
    tasks: ["chat", "general", "reasoning"],
  },
  {
    name: "qwen2.5-coder:7b",
    family: "qwen2",
    parameterSize: "7B",
    approxSizeBytes: Math.round(4.7 * GB),
    quantization: "Q4_K_M",
    tasks: ["code", "general"],
  },
  {
    name: "qwen2.5-coder:14b",
    family: "qwen2",
    parameterSize: "14B",
    approxSizeBytes: Math.round(9.0 * GB),
    quantization: "Q4_K_M",
    tasks: ["code", "general"],
  },
  {
    name: "qwen2.5-coder:32b",
    family: "qwen2",
    parameterSize: "32B",
    approxSizeBytes: Math.round(20 * GB),
    quantization: "Q4_K_M",
    tasks: ["code", "general"],
  },
  {
    name: "qwen2.5:7b",
    family: "qwen2",
    parameterSize: "7B",
    approxSizeBytes: Math.round(4.7 * GB),
    quantization: "Q4_K_M",
    tasks: ["chat", "general"],
  },
  {
    name: "qwen2.5:14b",
    family: "qwen2",
    parameterSize: "14B",
    approxSizeBytes: Math.round(9.0 * GB),
    quantization: "Q4_K_M",
    tasks: ["chat", "general", "reasoning"],
  },
  {
    name: "qwen2.5:32b",
    family: "qwen2",
    parameterSize: "32B",
    approxSizeBytes: Math.round(20 * GB),
    quantization: "Q4_K_M",
    tasks: ["chat", "general", "reasoning"],
  },
  {
    name: "qwen3:8b",
    family: "qwen3",
    parameterSize: "8B",
    approxSizeBytes: Math.round(5.2 * GB),
    quantization: "Q4_K_M",
    tasks: ["chat", "general", "reasoning"],
  },
  {
    name: "qwen3:14b",
    family: "qwen3",
    parameterSize: "14B",
    approxSizeBytes: Math.round(9.0 * GB),
    quantization: "Q4_K_M",
    tasks: ["chat", "general", "reasoning"],
  },
  {
    name: "mistral:7b",
    family: "mistral",
    parameterSize: "7B",
    approxSizeBytes: Math.round(4.1 * GB),
    quantization: "Q4_0",
    tasks: ["chat", "general"],
  },
  {
    name: "mistral-nemo:12b",
    family: "mistral",
    parameterSize: "12B",
    approxSizeBytes: Math.round(7.1 * GB),
    quantization: "Q4_K_M",
    tasks: ["chat", "general"],
  },
  {
    name: "mistral-small:24b",
    family: "mistral",
    parameterSize: "24B",
    approxSizeBytes: Math.round(14 * GB),
    quantization: "Q4_K_M",
    tasks: ["chat", "general", "reasoning"],
  },
  {
    name: "gemma2:9b",
    family: "gemma2",
    parameterSize: "9B",
    approxSizeBytes: Math.round(5.4 * GB),
    quantization: "Q4_0",
    tasks: ["chat", "general"],
  },
  {
    name: "gemma2:27b",
    family: "gemma2",
    parameterSize: "27B",
    approxSizeBytes: Math.round(16 * GB),
    quantization: "Q4_0",
    tasks: ["chat", "general", "reasoning"],
  },
  {
    name: "gemma3:4b",
    family: "gemma3",
    parameterSize: "4B",
    approxSizeBytes: Math.round(2.5 * GB),
    quantization: "Q4_K_M",
    tasks: ["chat", "general"],
  },
  {
    name: "gemma3:12b",
    family: "gemma3",
    parameterSize: "12B",
    approxSizeBytes: Math.round(7.5 * GB),
    quantization: "Q4_K_M",
    tasks: ["chat", "general", "reasoning"],
  },
  {
    name: "phi3.5:3.8b",
    family: "phi3",
    parameterSize: "3.8B",
    approxSizeBytes: Math.round(2.2 * GB),
    quantization: "Q4_0",
    tasks: ["chat", "general", "reasoning"],
  },
  {
    name: "phi4:14b",
    family: "phi4",
    parameterSize: "14B",
    approxSizeBytes: Math.round(9.1 * GB),
    quantization: "Q4_K_M",
    tasks: ["chat", "general", "reasoning"],
  },
  {
    name: "nomic-embed-text",
    family: "nomic-bert",
    parameterSize: "137M",
    approxSizeBytes: Math.round(0.27 * GB),
    quantization: "F16",
    tasks: ["embed"],
  },
  {
    name: "mxbai-embed-large",
    family: "bert",
    parameterSize: "335M",
    approxSizeBytes: Math.round(0.67 * GB),
    quantization: "F16",
    tasks: ["embed"],
  },
  {
    name: "bge-m3",
    family: "bert",
    parameterSize: "567M",
    approxSizeBytes: Math.round(1.2 * GB),
    quantization: "F16",
    tasks: ["embed"],
  },
  {
    name: "llava:7b",
    family: "llama",
    parameterSize: "7B",
    approxSizeBytes: Math.round(4.7 * GB),
    quantization: "Q4_0",
    tasks: ["vision", "chat"],
  },
  {
    name: "llava:13b",
    family: "llama",
    parameterSize: "13B",
    approxSizeBytes: Math.round(8.0 * GB),
    quantization: "Q4_0",
    tasks: ["vision", "chat"],
  },
  {
    name: "minicpm-v:8b",
    family: "qwen2",
    parameterSize: "8B",
    approxSizeBytes: Math.round(5.5 * GB),
    quantization: "Q4_K_M",
    tasks: ["vision", "chat"],
  },
  {
    name: "deepseek-r1:7b",
    family: "qwen2",
    parameterSize: "7B",
    approxSizeBytes: Math.round(4.7 * GB),
    quantization: "Q4_K_M",
    tasks: ["reasoning", "chat"],
  },
  {
    name: "deepseek-r1:14b",
    family: "qwen2",
    parameterSize: "14B",
    approxSizeBytes: Math.round(9.0 * GB),
    quantization: "Q4_K_M",
    tasks: ["reasoning", "chat"],
  },
  {
    name: "deepseek-r1:32b",
    family: "qwen2",
    parameterSize: "32B",
    approxSizeBytes: Math.round(20 * GB),
    quantization: "Q4_K_M",
    tasks: ["reasoning", "chat"],
  },
  {
    name: "codellama:7b",
    family: "llama",
    parameterSize: "7B",
    approxSizeBytes: Math.round(3.8 * GB),
    quantization: "Q4_0",
    tasks: ["code", "general"],
  },
  {
    name: "codellama:13b",
    family: "llama",
    parameterSize: "13B",
    approxSizeBytes: Math.round(7.4 * GB),
    quantization: "Q4_0",
    tasks: ["code", "general"],
  },
  {
    name: "codellama:34b",
    family: "llama",
    parameterSize: "34B",
    approxSizeBytes: Math.round(19 * GB),
    quantization: "Q4_0",
    tasks: ["code", "general"],
  },
  {
    name: "command-r:35b",
    family: "command-r",
    parameterSize: "35B",
    approxSizeBytes: Math.round(20 * GB),
    quantization: "Q4_K_M",
    tasks: ["chat", "general", "reasoning"],
  },
];

export function searchCatalog(query: string): CatalogModel[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...CATALOG];
  return CATALOG.filter((m) => {
    return (
      m.name.toLowerCase().includes(q) ||
      m.family.toLowerCase().includes(q) ||
      m.parameterSize.toLowerCase().includes(q) ||
      m.tasks.some((t) => t.toLowerCase().includes(q))
    );
  });
}

export function fitsIn(approxSizeBytes: number, freeBytes: number): boolean {
  return approxSizeBytes * 1.2 <= freeBytes;
}
