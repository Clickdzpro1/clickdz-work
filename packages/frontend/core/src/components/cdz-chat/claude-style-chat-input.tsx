"use client";

/**
 * CDZ Chat — main chat input (Claude-style).
 *
 * Adapted from the 21st.dev claude-style-chat-input component for the ClickDz
 * Work (AFFiNE fork) codebase. This is the PRIMARY chat input that replaces the
 * input area of the AI chat panel.
 *
 * Changes from the upstream component:
 *  1. `import { cn } from "@/lib/utils"` -> `import { cn } from "./cn"` (AFFiNE
 *     has no `@/` alias or `@/lib/utils`).
 *  2. Icons consolidated into `./icons` (lucide-react re-exports + the
 *     ClickDz starburst mark).
 *  3. The hardcoded `opus-4.5 / sonnet-4.5 / haiku-4.5` models are replaced by
 *     the CDZ model registry (`./cdz-models`) — 7 CDZ supermodels. The model
 *     selector now passes the CDZ model *id* to onSendMessage, so the host can
 *     dispatch straight to the CDZ AI API.
 *  4. Extended-thinking toggle is preserved and forwarded in the payload; the
 *     host maps it to cdz-sage (Opus 4.8) routing or a thinking parameter.
 *  5. On mount we inject the scoped Tailwind layer + `--cdz-*` tokens via
 *     `ensureCdzChatStyles()` (same orchestrator the sidechat uses).
 *  6. The component renders inside a `.cdz-chat-scope` wrapper for style
 *     isolation, so the scoped Tailwind utilities never leak into the rest of
 *     the AFFiNE app.
 *
 * Features preserved verbatim: file/image attach with preview, paste handling
 * (>300 chars becomes a content card), drag & drop, model selector dropdown,
 * extended-thinking toggle, auto-resize textarea, send-on-Enter.
 */
import { cn } from './cn';
import { ensureCdzChatStyles } from './cdz-styles';
import {
  CDZ_DEFAULT_MODEL_ID,
  CDZ_MODELS,
  type CdzModelOption,
} from './cdz-models';
import { Icons } from './icons';
import { useCdzI18n } from './use-cdz-i18n';
import { useCallback, useEffect, useRef, useState, type FC } from 'react';

/* --- UTILS --- */
const formatFileSize = (bytes: number) => {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
};

/* --- TYPES --- */
export interface AttachedFile {
  id: string;
  file: File;
  type: string;
  preview: string | null;
  uploadStatus: string;
  content?: string;
}

export interface PastedContent {
  id: string;
  content: string;
  timestamp: Date;
}

export interface ClaudeChatInputProps {
  /** Fired on send. The host dispatches to the CDZ AI runtime. */
  onSendMessage: (data: {
    message: string;
    files: AttachedFile[];
    pastedContent: PastedContent[];
    model: string; // CDZ model id, e.g. 'cdz-ultra'
    isThinkingEnabled: boolean;
  }) => void;
  /** Override the model list (defaults to the 7 CDZ supermodels). */
  models?: CdzModelOption[];
  /** Initially selected model id. */
  defaultModelId?: string;
  /** Placeholder text. */
  placeholder?: string;
}

/* --- SUB-COMPONENTS --- */
interface FilePreviewCardProps {
  file: AttachedFile;
  onRemove: (id: string) => void;
}
const FilePreviewCard: FC<FilePreviewCardProps> = ({ file, onRemove }) => {
  const isImage = file.type.startsWith('image/') && file.preview;
  return (
    <div
      className={cn(
        'relative group flex-shrink-0 w-24 h-24 rounded-xl overflow-hidden border border-bg-300 bg-bg-200 animate-fade-in transition-all hover:border-text-400'
      )}
    >
      {isImage ? (
        <div className="w-full h-full relative">
          <img
            src={file.preview ?? ''}
            alt={file.file.name}
            className="w-full h-full object-cover"
          />
          <div className="absolute inset-0 bg-black/20 group-hover:bg-black/0 transition-colors" />
        </div>
      ) : (
        <div className="w-full h-full p-3 flex flex-col justify-between">
          <div className="flex items-center gap-2">
            <div className="p-1.5 bg-bg-300 rounded">
              <Icons.FileText className="w-4 h-4 text-text-300" />
            </div>
            <span className="text-[10px] font-medium text-text-400 uppercase tracking-wider truncate">
              {file.file.name.split('.').pop()}
            </span>
          </div>
          <div className="space-y-0.5">
            <p
              className="text-xs font-medium text-text-200 truncate"
              title={file.file.name}
            >
              {file.file.name}
            </p>
            <p className="text-[10px] text-text-500">
              {formatFileSize(file.file.size)}
            </p>
          </div>
        </div>
      )}
      <button
        onClick={() => onRemove(file.id)}
        className="absolute top-1 right-1 p-1 bg-black/50 hover:bg-black/70 rounded-full text-white opacity-0 group-hover:opacity-100 transition-opacity"
        aria-label={`Remove ${file.file.name}`}
      >
        <Icons.X className="w-3 h-3" />
      </button>
      {file.uploadStatus === 'uploading' && (
        <div className="absolute inset-0 bg-black/40 flex items-center justify-center">
          <Icons.Loader2 className="w-5 h-5 text-white animate-spin" />
        </div>
      )}
    </div>
  );
};

interface PastedContentCardProps {
  content: PastedContent;
  onRemove: (id: string) => void;
}
const PastedContentCard: FC<PastedContentCardProps> = ({ content, onRemove }) => {
  return (
    <div className="relative group flex-shrink-0 w-28 h-28 rounded-2xl overflow-hidden border border-bg-300 bg-bg-100 animate-fade-in p-3 flex flex-col justify-between shadow-[0_1px_2px_rgba(0,0,0,0.05)]">
      <div className="overflow-hidden w-full">
        <p className="text-[10px] text-text-300 leading-[1.4] font-mono break-words whitespace-pre-wrap line-clamp-4 select-none">
          {content.content}
        </p>
      </div>
      <div className="flex items-center justify-between w-full mt-2">
        <div className="inline-flex items-center justify-center px-1.5 py-[2px] rounded border border-bg-300 bg-bg-100">
          <span className="text-[9px] font-bold text-text-300 uppercase tracking-wider font-sans">
            PASTED
          </span>
        </div>
      </div>
      <button
        onClick={() => onRemove(content.id)}
        className="absolute top-2 right-2 p-[3px] bg-bg-100 border border-bg-300 rounded-full text-text-400 hover:text-text-200 transition-colors shadow-sm opacity-0 group-hover:opacity-100"
        aria-label="Remove pasted content"
      >
        <Icons.X className="w-2 h-2" />
      </button>
    </div>
  );
};

interface ModelSelectorProps {
  models: CdzModelOption[];
  selectedModelId: string;
  onSelect: (modelId: string) => void;
}
const ModelSelector: FC<ModelSelectorProps> = ({
  models,
  selectedModelId,
  onSelect,
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const currentModel =
    models.find(m => m.id === selectedModelId) ?? models[0];
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(event.target as Node)
      ) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);
  return (
    <div className="relative" ref={dropdownRef}>
      <button
        onClick={() => setIsOpen(!isOpen)}
        className={cn(
          'inline-flex items-center justify-center relative shrink-0 transition font-base duration-300 ease-[cubic-bezier(0.165,0.85,0.45,1)] h-8 rounded-xl px-3 min-w-[4rem] active:scale-[0.98] whitespace-nowrap !text-xs pl-2.5 pr-2 gap-1',
          isOpen
            ? 'bg-bg-200 text-text-100'
            : 'text-text-300 hover:text-text-200 hover:bg-bg-200'
        )}
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        aria-label={`Select model. Current: ${currentModel?.label ?? 'CDZ'}`}
      >
        <div className="font-ui inline-flex gap-[3px] text-[14px] h-[14px] leading-none items-baseline">
          <div className="flex items-center gap-[4px]">
            <div className="whitespace-nowrap select-none font-medium">
              {currentModel?.label ?? 'CDZ Ultra'}
            </div>
          </div>
        </div>
        <div
          className="flex items-center justify-center opacity-75"
          style={{ width: '20px', height: '20px' }}
        >
          <Icons.SelectArrow
            className={cn(
              'shrink-0 opacity-75 transition-transform duration-200',
              isOpen ? 'rotate-180' : ''
            )}
          />
        </div>
      </button>
      {isOpen && (
        <div
          role="listbox"
          className="absolute bottom-full right-0 mb-2 w-[260px] bg-bg-100 border border-bg-300 rounded-2xl shadow-2xl overflow-hidden z-50 flex flex-col p-1.5 animate-fade-in origin-bottom-right max-h-[320px] overflow-y-auto prompt-scrollbar"
        >
          {models.map(model => (
            <button
              key={model.id}
              role="option"
              aria-selected={selectedModelId === model.id}
              onClick={() => {
                onSelect(model.id);
                setIsOpen(false);
              }}
              className="w-full text-left px-3 py-2.5 rounded-xl flex items-start justify-between group transition-colors hover:bg-bg-200"
            >
              <div className="flex flex-col gap-0.5">
                <div className="flex items-center gap-2">
                  <span
                    className={cn(
                      'inline-block w-1.5 h-1.5 rounded-full',
                      model.badge
                    )}
                    style={{
                      backgroundColor: `var(--cdz-${model.badge})`,
                    }}
                    aria-hidden="true"
                  />
                  <span className="text-[13px] font-semibold text-text-100">
                    {model.label}
                  </span>
                </div>
                <span className="text-[11px] text-text-300">
                  {model.description}
                </span>
              </div>
              {selectedModelId === model.id && (
                <Icons.Check
                  className="w-4 h-4 mt-1"
                  style={{ color: 'var(--cdz-accent)' }}
                />
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

/* --- MAIN COMPONENT --- */
export const ClaudeChatInput: FC<ClaudeChatInputProps> = ({
  onSendMessage,
  models = CDZ_MODELS,
  defaultModelId = CDZ_DEFAULT_MODEL_ID,
  placeholder,
}) => {
  const t = useCdzI18n();
  const resolvedPlaceholder = placeholder ?? t.chat.input.placeholder();
  const [message, setMessage] = useState('');
  const [files, setFiles] = useState<AttachedFile[]>([]);
  const [pastedContent, setPastedContent] = useState<PastedContent[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [selectedModelId, setSelectedModelId] = useState(defaultModelId);
  const [isThinkingEnabled, setIsThinkingEnabled] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Inject scoped Tailwind layer + --cdz-* tokens once on mount.
  useEffect(() => {
    ensureCdzChatStyles();
  }, []);

  // Auto-resize textarea
  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height =
        Math.min(textareaRef.current.scrollHeight, 384) + 'px';
    }
  }, [message]);

  // File Handling
  const handleFiles = useCallback((newFilesList: FileList | File[]) => {
    const newFiles: AttachedFile[] = Array.from(newFilesList).map(file => {
      const isImage =
        file.type.startsWith('image/') ||
        /\.(jpg|jpeg|png|gif|webp|svg)$/i.test(file.name);
      return {
        id: Math.random().toString(36).slice(2, 11),
        file,
        type: isImage ? 'image/unknown' : file.type || 'application/octet-stream',
        preview: isImage ? URL.createObjectURL(file) : null,
        uploadStatus: 'pending',
      };
    });
    setFiles(prev => [...prev, ...newFiles]);
    setMessage(prev => {
      if (prev) return prev;
      if (newFiles.length === 1) {
        const f = newFiles[0];
        if (f.type.startsWith('image/')) return t.chat.input.analyzedImage();
        return t.chat.input.analyzedDocument();
      }
      return t.chat.input.analyzedFiles(newFiles.length);
    });
    newFiles.forEach(f => {
      setTimeout(() => {
        setFiles(prev =>
          prev.map(p => (p.id === f.id ? { ...p, uploadStatus: 'complete' } : p))
        );
      }, 800 + Math.random() * 1000);
    });
  }, []);

  // Drag & Drop
  const onDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  };
  const onDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  };
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    if (e.dataTransfer.files) handleFiles(e.dataTransfer.files);
  };

  // Paste Handling
  const handlePaste = (e: React.ClipboardEvent) => {
    const items = e.clipboardData.items;
    const pastedFiles: File[] = [];
    for (let i = 0; i < items.length; i++) {
      if (items[i].kind === 'file') {
        const file = items[i].getAsFile();
        if (file) pastedFiles.push(file);
      }
    }
    if (pastedFiles.length > 0) {
      e.preventDefault();
      handleFiles(pastedFiles);
      return;
    }
    const text = e.clipboardData.getData('text');
    if (text.length > 300) {
      e.preventDefault();
      const snippet: PastedContent = {
        id: Math.random().toString(36).slice(2, 11),
        content: text,
        timestamp: new Date(),
      };
      setPastedContent(prev => [...prev, snippet]);
      if (!message) {
        setMessage(t.chat.input.analyzedPasted());
      }
    }
  };

  const handleSend = () => {
    if (!message.trim() && files.length === 0 && pastedContent.length === 0)
      return;
    onSendMessage({
      message,
      files,
      pastedContent,
      model: selectedModelId,
      isThinkingEnabled,
    });
    setMessage('');
    setFiles([]);
    setPastedContent([]);
    if (textareaRef.current) textareaRef.current.style.height = 'auto';
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const hasContent =
    message.trim() || files.length > 0 || pastedContent.length > 0;

  return (
    <div
      className={cn(
        'cdz-chat-scope relative w-full max-w-2xl mx-auto transition-all duration-300 font-sans'
      )}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <div
        className={cn(
          '!box-content flex flex-col mx-2 md:mx-0 items-stretch transition-all duration-200 relative z-10 rounded-2xl cursor-text border border-bg-300',
          'shadow-[0_0_15px_rgba(0,0,0,0.08)] hover:shadow-[0_0_20px_rgba(0,0,0,0.12)] focus-within:shadow-[0_0_25px_rgba(0,0,0,0.15)]',
          'bg-bg-100 font-sans antialiased'
        )}
      >
        <div className="flex flex-col px-3 pt-3 pb-2 gap-2">
          {/* Artifacts (files & pastes) — above the text input */}
          {(files.length > 0 || pastedContent.length > 0) && (
            <div className="flex gap-3 overflow-x-auto prompt-scrollbar pb-2 px-1">
              {pastedContent.map(content => (
                <PastedContentCard
                  key={content.id}
                  content={content}
                  onRemove={id =>
                    setPastedContent(prev =>
                      prev.filter(c => c.id !== id)
                    )
                  }
                />
              ))}
              {files.map(file => (
                <FilePreviewCard
                  key={file.id}
                  file={file}
                  onRemove={id =>
                    setFiles(prev => prev.filter(f => f.id !== id))
                  }
                />
              ))}
            </div>
          )}

          {/* Input Area */}
          <div className="relative mb-1">
            <div className="max-h-96 w-full overflow-y-auto prompt-scrollbar font-sans break-words transition-opacity duration-200 min-h-[2.5rem] pl-1">
              <textarea
                ref={textareaRef}
                value={message}
                onChange={e => setMessage(e.target.value)}
                onPaste={handlePaste}
                onKeyDown={handleKeyDown}
                placeholder={resolvedPlaceholder}
                className="w-full bg-transparent border-0 outline-none text-text-100 text-[16px] placeholder:text-text-400 resize-none overflow-hidden py-0 leading-relaxed block font-normal antialiased"
                rows={1}
                autoFocus
                style={{ minHeight: '1.5em' }}
                aria-label={t.chat.input.placeholder()}
              />
            </div>
          </div>

          {/* Action Bar */}
          <div className="flex gap-2 w-full items-center">
            {/* Left Tools */}
            <div className="relative flex-1 flex items-center shrink min-w-0 gap-1">
              <button
                onClick={() => fileInputRef.current?.click()}
                className="inline-flex items-center justify-center relative shrink-0 transition-colors duration-200 h-8 w-8 rounded-lg active:scale-95 text-text-400 hover:text-text-200 hover:bg-bg-200"
                type="button"
                aria-label={t.chat.input.attachFile()}
              >
                <Icons.Plus className="w-5 h-5" />
              </button>
              <div className="flex shrink min-w-8 !shrink-0">
                <button
                  onClick={() => setIsThinkingEnabled(!isThinkingEnabled)}
                  className={cn(
                    'transition-all duration-200 h-8 w-8 flex items-center justify-center rounded-lg active:scale-95',
                    isThinkingEnabled
                      ? 'text-accent bg-accent/10'
                      : 'text-text-400 hover:text-text-200 hover:bg-bg-200'
                  )}
                  aria-pressed={isThinkingEnabled}
                  aria-label={t.chat.input.extendedThinking()}
                  title={t.chat.input.extendedThinking()}
                >
                  <Icons.Thinking className="w-5 h-5" />
                </button>
              </div>
            </div>
            {/* Right Tools */}
            <div className="flex flex-row items-center min-w-0 gap-1">
              <div className="shrink-0 p-1 -m-1">
                <ModelSelector
                  models={models}
                  selectedModelId={selectedModelId}
                  onSelect={setSelectedModelId}
                />
              </div>
              <div>
                <button
                  onClick={handleSend}
                  disabled={!hasContent}
                  className={cn(
                    'inline-flex items-center justify-center relative shrink-0 transition-colors h-8 w-8 rounded-md active:scale-95 !rounded-xl !h-8 !w-8',
                    hasContent
                      ? 'bg-accent text-bg-0 hover:bg-accent-hover shadow-md'
                      : 'bg-accent/30 text-bg-0/60 cursor-default'
                  )}
                  type="button"
                  aria-label={t.chat.input.send()}
                >
                  <Icons.ArrowUp className="w-4 h-4" />
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Drag Overlay */}
      {isDragging && (
        <div className="absolute inset-0 bg-bg-200/90 border-2 border-dashed border-accent rounded-2xl z-50 flex flex-col items-center justify-center backdrop-blur-sm pointer-events-none">
          <Icons.Archive className="w-10 h-10 mb-2 animate-bounce" style={{ color: 'var(--cdz-accent)' }} />
          <p className="font-medium" style={{ color: 'var(--cdz-accent)' }}>
            Drop files to upload
          </p>
        </div>
      )}

      {/* Hidden file input */}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        onChange={e => {
          if (e.target.files) handleFiles(e.target.files);
          e.target.value = '';
        }}
        aria-hidden="true"
        tabIndex={-1}
      />

      <div className="text-center mt-4">
        <p className="text-xs text-text-500">
          {t.chat.input.disclaimer()}
        </p>
      </div>
    </div>
  );
};

export default ClaudeChatInput;
