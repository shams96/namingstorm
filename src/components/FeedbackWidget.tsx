import { useState } from 'react';
import { Bug, X, Loader2, Paperclip } from 'lucide-react';
import { collection, addDoc, serverTimestamp } from 'firebase/firestore';
import { toast } from 'sonner';
import { auth, db } from '../firebase';

// Downscales and re-encodes the screenshot client-side so the resulting data
// URL comfortably clears Firestore's 1MiB document limit (validated server-side
// in firestore.rules as < 500,000 chars) without needing Storage/a bucket.
const MAX_DIMENSION = 1000;
const JPEG_QUALITY = 0.6;

function compressImage(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Failed to read file'));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('Failed to decode image'));
      img.onload = () => {
        const scale = Math.min(1, MAX_DIMENSION / Math.max(img.width, img.height));
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(img.width * scale);
        canvas.height = Math.round(img.height * scale);
        const ctx = canvas.getContext('2d');
        if (!ctx) return reject(new Error('Canvas unsupported'));
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL('image/jpeg', JPEG_QUALITY));
      };
      img.src = reader.result as string;
    };
    reader.readAsDataURL(file);
  });
}

export function FeedbackWidget() {
  const [open, setOpen] = useState(false);
  const [description, setDescription] = useState('');
  const [screenshot, setScreenshot] = useState<string | null>(null);
  const [screenshotName, setScreenshotName] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const reset = () => {
    setDescription('');
    setScreenshot(null);
    setScreenshotName('');
  };

  const handleFile = async (file: File | undefined) => {
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      toast.error('Please attach an image file.');
      return;
    }
    try {
      const dataUrl = await compressImage(file);
      setScreenshot(dataUrl);
      setScreenshotName(file.name);
    } catch {
      toast.error('Could not read that image — try a different file.');
    }
  };

  const handleSubmit = async () => {
    if (!description.trim()) {
      toast.error('Tell us what happened first.');
      return;
    }
    setSubmitting(true);
    try {
      await addDoc(collection(db, 'feedback'), {
        description: description.trim().slice(0, 2000),
        ...(screenshot ? { screenshot } : {}),
        page: window.location.pathname + window.location.search,
        userAgent: navigator.userAgent.slice(0, 300),
        uid: auth.currentUser?.uid ?? null,
        email: auth.currentUser?.email ?? null,
        createdAt: serverTimestamp(),
      });
      toast.success("Thanks — we'll look into it.", {
        style: { background: '#050505', color: '#CCFF00', border: '1px solid #CCFF00' },
      });
      reset();
      setOpen(false);
    } catch (err) {
      console.error('Feedback submit error:', err);
      toast.error('Failed to send feedback. Please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title="Report an issue"
        className="fixed bottom-5 right-5 z-40 w-11 h-11 rounded-full bg-zinc-900 border border-zinc-700 hover:border-[#CCFF00] text-zinc-400 hover:text-[#CCFF00] flex items-center justify-center transition-colors shadow-lg"
      >
        <Bug className="w-4 h-4" />
      </button>

      {open && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-4 bg-black/80 backdrop-blur-sm">
          <div className="w-full max-w-sm border border-zinc-800 bg-[#050505] p-5">
            <div className="flex items-center justify-between mb-4">
              <p className="text-[10px] font-mono text-[#CCFF00] uppercase tracking-[0.2em]">Report an Issue</p>
              <button onClick={() => { setOpen(false); reset(); }} className="text-zinc-500 hover:text-white">
                <X className="w-4 h-4" />
              </button>
            </div>

            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What happened? What did you expect instead?"
              rows={4}
              maxLength={2000}
              className="w-full bg-zinc-950 border border-zinc-800 focus:border-[#CCFF00] text-sm font-mono text-white p-3 mb-3 outline-none resize-none placeholder:text-zinc-600"
            />

            <label className="flex items-center gap-2 text-[10px] font-mono text-zinc-500 uppercase tracking-widest cursor-pointer hover:text-zinc-300 mb-1 w-fit">
              <Paperclip className="w-3 h-3" />
              {screenshotName || 'Attach screenshot (optional)'}
              <input
                type="file"
                accept="image/*"
                className="hidden"
                onChange={(e) => handleFile(e.target.files?.[0])}
              />
            </label>
            {screenshot && (
              <div className="mb-3 border border-zinc-800 overflow-hidden">
                <img src={screenshot} alt="Attached screenshot preview" className="w-full max-h-40 object-contain bg-black" />
              </div>
            )}

            <button
              onClick={handleSubmit}
              disabled={submitting}
              className="w-full bg-[#CCFF00] hover:bg-[#E6FF00] disabled:opacity-50 text-black font-mono font-bold text-[11px] uppercase tracking-widest py-3 transition-colors flex items-center justify-center gap-2 mt-2"
            >
              {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Send Feedback'}
            </button>
          </div>
        </div>
      )}
    </>
  );
}
