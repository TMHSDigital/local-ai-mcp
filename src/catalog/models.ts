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
    name: "qwen2.5-coder:7b",
    family: "qwen2",
    parameterSize: "7B",
    approxSizeBytes: Math.round(4.7 * GB),
    quantization: "Q4_K_M",
    tasks: ["code", "general"],
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
    name: "mistral:7b",
    family: "mistral",
    parameterSize: "7B",
    approxSizeBytes: Math.round(4.1 * GB),
    quantization: "Q4_0",
    tasks: ["chat", "general"],
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
    name: "phi3.5:3.8b",
    family: "phi3",
    parameterSize: "3.8B",
    approxSizeBytes: Math.round(2.2 * GB),
    quantization: "Q4_0",
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
    name: "llava:7b",
    family: "llama",
    parameterSize: "7B",
    approxSizeBytes: Math.round(4.7 * GB),
    quantization: "Q4_0",
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
    name: "codellama:13b",
    family: "llama",
    parameterSize: "13B",
    approxSizeBytes: Math.round(7.4 * GB),
    quantization: "Q4_0",
    tasks: ["code", "general"],
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
