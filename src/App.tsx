import { useState, useEffect, useMemo, useRef, MouseEvent } from 'react';
import Markdown from 'react-markdown';
import { Terminal, Zap, Compass, Activity, Loader2, LogIn, LogOut, CheckCircle, ShieldCheck, CreditCard, History, ChevronRight, Fingerprint, Menu, X, Globe, FileText, Sparkles, Timer, Handshake, MousePointerClick, Volume2, RefreshCw, Download, TrendingUp, Star, BookOpen, Share2, Users, ChevronDown, ChevronUp, Clock, Target } from 'lucide-react';
import { auth, db, loginWithGoogle, loginAsGuest, logout, handleFirestoreError, OperationType } from './firebase';
import { onAuthStateChanged, User } from 'firebase/auth';
import { collection, addDoc, onSnapshot, query, where, orderBy, serverTimestamp, doc, setDoc, getDoc, updateDoc } from 'firebase/firestore';
import { Toaster, toast } from 'sonner';
import { motion, AnimatePresence, MotionConfig } from 'motion/react';
import { parseNames, parseEvolvedNames, parseNamePool, shouldShowPaywall } from './utils/parseNames';
import { scoreNameFn, getSoundProfile } from './utils/nameScoring';
import { FeedbackWidget } from './components/FeedbackWidget';

const FREE_SEARCH_LIMIT = 5;
const PAID_SEARCH_PACK_SIZE = 10;

declare global {
  interface Window {
    aistudio?: {
      hasSelectedApiKey: () => Promise<boolean>;
      openSelectKey: () => Promise<void>;
    };
  }
}

const INSPIRATION_IDEAS = [
  { label: 'SaaS / AI', desc: 'An AI-powered project management platform that predicts team bottlenecks before they happen.', audience: 'Engineering managers, CTOs at Series A+ startups', context: 'Needs to sound intelligent, fast, and trustworthy. Avoid generic -ify or -ly suffixes. Think precision.' },
  { label: 'Fintech', desc: 'A B2B payment infrastructure startup that lets any software company embed financial services in 10 minutes.', audience: 'Developer-founders, CFOs at mid-market companies', context: 'Think Stripe-like: clean, technical, short. Strong trademark posture is critical.' },
  { label: 'Health', desc: 'A longevity-focused wellness brand offering personalized supplement stacks based on blood biomarker data.', audience: 'Biohackers, high-performing executives 35-55', context: 'Balance science credibility with approachability. Latin/Greek bio-roots work well.' },
  { label: 'Gaming', desc: 'A cross-platform gaming social layer that replaces Discord for competitive teams.', audience: 'Esports athletes, Gen Z competitive gamers', context: 'High energy, punchy, 1-2 syllables. Can use aggressive or abstract sound symbolism.' },
  { label: 'E-commerce', desc: 'A direct-to-consumer brand selling sustainable, minimalist everyday carry items.', audience: 'Urban millennials, design enthusiasts', context: 'Focus on sustainability, minimalism, and modern lifestyle. Avoid overly technical terms.' },
  { label: 'Consumer', desc: 'A premium, high-caffeine sparkling water for gamers and creators.', audience: 'Gen Z, Twitch streamers, esports athletes', context: 'High energy, punchy, memorable. Can use playful or aggressive sound symbolism.' },
  { label: 'Luxury', desc: 'An ultra-high-end skincare line using deep-sea minerals.', audience: 'Affluent women 35+, beauty connoisseurs', context: 'Elegant, sophisticated, evocative of the ocean and purity. French or Italian influence is acceptable.' },
  { label: 'Legal / B2B', desc: 'A contract intelligence platform that auto-redlines legal documents using AI trained on 10M+ contracts.', audience: 'GCs, in-house legal teams at Fortune 500', context: 'Must convey precision, authority, and trust. Avoid startup-sounding names. Think: gravitas.' },
];

// SSE streams occasionally stall mid-response under upstream high-demand
// conditions (Gemini returns 200 and starts streaming, then goes silent
// without erroring or sending [DONE]). Without an idle timeout the UI just
// shows "Processing..." indefinitely until the underlying request eventually
// times out on its own, which can take a minute or more. This races each
// chunk read against an idle window so a stalled stream surfaces as a
// retryable error quickly instead of looking hung.
//
// This must sit above the server's own worst-case time-to-first-byte, not
// just "normal" latency. gemini-3.5-flash has genuine thinking latency before
// the first streamed token that varies a lot on this prompt — measured
// directly anywhere from ~20s to 109s across otherwise-identical requests —
// and the server (server.ts) retries up to 3 attempts at 60s each on a
// timeout/transient failure, a worst case of ~3 minutes before it can even
// report failure. If this client timeout is shorter than that, it aborts and
// reports "stalled" on requests the server was still legitimately working on
// and would have completed. So this is set above the server's own worst case,
// not tuned for the common case — the common case finishes well before this.
const STREAM_IDLE_TIMEOUT_MS = 190000;

async function readSSEChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>
): Promise<ReadableStreamReadResult<Uint8Array>> {
  let timeoutId: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      reader.cancel().catch(() => {});
      reject(new Error('Stream stalled — no response from the AI engine. Please try again.'));
    }, STREAM_IDLE_TIMEOUT_MS);
  });
  try {
    return await Promise.race([reader.read(), timeout]);
  } finally {
    clearTimeout(timeoutId!);
  }
}

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [isAuthReady, setIsAuthReady] = useState(false);
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
  // "Guest" is now a real (anonymous) Firebase Auth identity, not a home-rolled
  // sessionStorage id — so guest runs persist to Firestore and survive a
  // browser restart (until they clear site data), same as logged-in accounts.
  const isGuest = !!user?.isAnonymous;
  const guestBannerRef = useRef<HTMLDivElement>(null);
  const [fixedTopOffset, setFixedTopOffset] = useState(0);
  const [userPhone, setUserPhone] = useState<string | null>(null);
  const [showPhonePrompt, setShowPhonePrompt] = useState(false);
  const [phoneInput, setPhoneInput] = useState('');
  const [savingPhone, setSavingPhone] = useState(false);
  
  const [productDescription, setProductDescription] = useState('');
  const [positioningStatement, setPositioningStatement] = useState('');
  const [targetAudience, setTargetAudience] = useState('');
  const [additionalContext, setAdditionalContext] = useState('');
  const [thinkingLevel, setThinkingLevel] = useState(50);
  const [selectedInspiration, setSelectedInspiration] = useState<string | null>(null);
  
  const [loading, setLoading] = useState(false);
  const [generationStage, setGenerationStage] = useState<'idle' | 'screening' | 'writing'>('idle');
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [response, setResponse] = useState('');
  const [currentProjectId, setCurrentProjectId] = useState<string | null>(null);
  
  const [projects, setProjects] = useState<any[]>([]);

  // Domain lookup for the "Secure Your Asset" panel — backed by the same
  // real RDAP check (/api/check-domain) used everywhere else in the app.
  // Previously this simulated a fake "brokerage appraisal" with Math.random()
  // pricing keyed off name length and a fake "deposit processed" payment flow
  // that never checked real availability or moved real money — see incident
  // where a genuinely-available domain (baryth.com) was shown as third-party-
  // owned with a fabricated $1,516 acquisition cost. Removed entirely.
  const [selectedName, setSelectedName] = useState('');
  const [domainStatus, setDomainStatus] = useState<'idle' | 'checking' | 'available' | 'taken' | 'unknown'>('idle');
  const [domainVariant, setDomainVariant] = useState<{ domain: string; technique: string } | null>(null);

  // Preliminary USPTO screen (NOT legal clearance — see TRADEMARK_DISCLAIMER
  // fallback text and server.ts's /api/check-trademark for why).
  const [trademarkStatus, setTrademarkStatus] = useState<'idle' | 'checking' | 'clear' | 'caution' | 'conflict' | 'unavailable'>('idle');
  const [trademarkMatches, setTrademarkMatches] = useState<{ mark: string; status: string; serialNumber: string | null }[]>([]);
  const [trademarkDisclaimer, setTrademarkDisclaimer] = useState('');
  const [trademarkError, setTrademarkError] = useState('');

  const [apiKeyError, setApiKeyError] = useState(false);

  const [evolveTarget, setEvolveTarget] = useState<string | null>(null);
  const [evolveResponse, setEvolveResponse] = useState('');
  const [evolveLoading, setEvolveLoading] = useState(false);
  const [parsedEvolvedNames, setParsedEvolvedNames] = useState<string[]>([]);
  const [domainAvailability, setDomainAvailability] = useState<Record<string, 'checking' | 'available' | 'taken' | 'unknown'>>({});
  const [gridDomainVariants, setGridDomainVariants] = useState<Record<string, { domain: string; technique: string } | null>>({});

  // Competitors input
  const [competitors, setCompetitors] = useState('');
  const [showCompetitors, setShowCompetitors] = useState(false);

  // Favorites (localStorage)
  const [favorites, setFavorites] = useState<string[]>(() => {
    try { return JSON.parse(localStorage.getItem('sl_favorites') || '[]'); } catch { return []; }
  });

  // Name History (sessionStorage)
  const [nameHistory, setNameHistory] = useState<{ names: string[]; prompt: string; ts: number }[]>(() => {
    try { return JSON.parse(sessionStorage.getItem('sl_history') || '[]'); } catch { return []; }
  });
  const [isHistoryOpen, setIsHistoryOpen] = useState(false);

  // Brand Story
  const [brandStoryTarget, setBrandStoryTarget] = useState<string | null>(null);
  const [brandStoryText, setBrandStoryText] = useState('');
  const [brandStoryLoading, setBrandStoryLoading] = useState(false);

  // Monetization / Paywall
  const [freeReportsUsed, setFreeReportsUsed] = useState(() => Number(sessionStorage.getItem('sl_free_count') || '0'));
  const [paidCredits, setPaidCredits] = useState(() => Number(sessionStorage.getItem('sl_paid_credits') || '0'));
  const [isPro, setIsPro] = useState(false);
  const [showPaywall, setShowPaywall] = useState(false);
  const [paywallLoading, setPaywallLoading] = useState<'report' | 'pro' | null>(null);
  const [showAccountModal, setShowAccountModal] = useState(false);

  const parsedNames = useMemo(() => parseNames(response), [response]);

  const [alternativeNames, setAlternativeNames] = useState<string[]>([]);
  const [alternativeAvailability, setAlternativeAvailability] = useState<Record<string, 'checking' | 'available' | 'taken' | 'unknown'>>({});
  const [generatingAlternatives, setGeneratingAlternatives] = useState(false);
  const [alternativesExhausted, setAlternativesExhausted] = useState(false);

  // Check real .com availability for all generated names via RDAP
  useEffect(() => {
    if (parsedNames.length === 0) { setDomainAvailability({}); setGridDomainVariants({}); return; }
    const initial: Record<string, 'checking'> = {};
    parsedNames.forEach(n => { initial[n] = 'checking'; });
    setDomainAvailability(initial);
    setGridDomainVariants({});
    const controller = new AbortController();
    parsedNames.forEach(async (name) => {
      const clean = name.toLowerCase().replace(/[^a-z0-9]/g, '');
      try {
        const r = await fetch(`/api/check-domain?name=${encodeURIComponent(clean)}`, { signal: controller.signal });
        const data = await r.json();
        setDomainAvailability(prev => ({
          ...prev,
          [name]: data.available === true ? 'available' : data.available === false ? 'taken' : 'unknown'
        }));
        setGridDomainVariants(prev => ({ ...prev, [name]: data.variant ?? null }));
      } catch (err) {
        if ((err as Error)?.name === 'AbortError') return;
        setDomainAvailability(prev => ({ ...prev, [name]: 'unknown' }));
      }
    });
    return () => controller.abort();
  }, [parsedNames]);

  // Auto-generate alternatives when 2+ names are taken
  useEffect(() => {
    const takenCount = Object.values(domainAvailability).filter(v => v === 'taken').length;
    const totalChecked = Object.values(domainAvailability).filter(v => v !== 'checking').length;

    if (totalChecked >= 3 && takenCount >= 2 && !generatingAlternatives && alternativeNames.length === 0) {
      generateAlternatives();
    }
  }, [domainAvailability]);

  // Streams one /api/evolve call and returns the parsed candidate names.
  const fetchEvolvedVariants = async (
    headers: Record<string, string>,
    seedName: string,
    excludeNames: string[],
    divergence: 'close' | 'wide'
  ): Promise<string[]> => {
    const res = await fetch('/api/evolve', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        name: seedName,
        productDescription,
        targetAudience,
        count: 10,
        excludeNames,
        divergence,
      }),
    });
    if (!res.ok) throw new Error('Failed to generate alternatives');

    const reader = res.body?.getReader();
    if (!reader) throw new Error('No stream');

    const dec = new TextDecoder();
    let buf = '', full = '';
    while (true) {
      const { done, value } = await readSSEChunk(reader);
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split('\n\n');
      buf = lines.pop() || '';
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const d = line.slice(6);
        if (d === '[DONE]') continue;
        try { const p = JSON.parse(d); if (p.text) full += p.text; } catch {}
      }
    }
    return parseEvolvedNames(full);
  };

  // Finds names the user can actually register. A single evolve call that stays
  // phonetically close to an already-taken name tends to land back in the same
  // domain-squatter cluster, so this escalates: round 1 evolves close to the
  // taken name, later rounds go wide with fresh naming strategies and an
  // exclude list, until enough confirmed-available names are found or we give up.
  const generateAlternatives = async () => {
    setGeneratingAlternatives(true);
    setAlternativesExhausted(false);
    const TARGET_AVAILABLE = 4;
    const MAX_ROUNDS = 4;

    try {
      const takenNames = Object.entries(domainAvailability)
        .filter(([, v]) => v === 'taken')
        .map(([n]) => n);
      if (takenNames.length === 0) return;

      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (user) headers['Authorization'] = `Bearer ${await user.getIdToken()}`;

      const seen = new Set<string>(parsedNames);
      const availabilityMap: Record<string, 'available' | 'taken' | 'unknown'> = {};
      const orderedNames: string[] = [];

      // Guaranteed layer: every taken name may already have a confirmed-available
      // deterministic domain variant (La-prefix/doubled-letter/+e/+s) — the exact
      // same data the grid cards above use — fetched when we screened for exact
      // .com availability. Surface it immediately rather than running a blind AI
      // search that has no idea this already exists; otherwise this panel can
      // report "no alternatives found" while a real one sits in the card above it.
      for (const taken of takenNames) {
        const variant = gridDomainVariants[taken];
        if (!variant) continue;
        const variantName = variant.domain.replace(/\.com$/i, '');
        const properCased = variantName.charAt(0).toUpperCase() + variantName.slice(1);
        if (seen.has(properCased)) continue;
        seen.add(properCased);
        orderedNames.push(properCased);
        availabilityMap[properCased] = 'available';
      }
      if (orderedNames.length > 0) {
        setAlternativeNames([...orderedNames]);
        setAlternativeAvailability(prev => ({
          ...prev,
          ...Object.fromEntries(orderedNames.map(n => [n, 'available' as const])),
        }));
      }

      for (let round = 0; round < MAX_ROUNDS; round++) {
        const availableCount = orderedNames.filter(n => availabilityMap[n] === 'available').length;
        if (availableCount >= TARGET_AVAILABLE) break;

        const divergence: 'close' | 'wide' = round === 0 ? 'close' : 'wide';
        const seedName = takenNames[round % takenNames.length];

        let variants: string[];
        try {
          variants = await fetchEvolvedVariants(headers, seedName, Array.from(seen), divergence);
        } catch (err) {
          console.error('Alternative generation error:', err);
          break;
        }

        const newNames = variants.filter(n => !seen.has(n));
        if (newNames.length === 0) break; // model has nothing new left to offer

        newNames.forEach(n => seen.add(n));
        orderedNames.push(...newNames);
        setAlternativeNames([...orderedNames]);

        const pending: Record<string, 'checking'> = {};
        newNames.forEach(n => { pending[n] = 'checking'; });
        setAlternativeAvailability(prev => ({ ...prev, ...pending }));

        const extraVariants: string[] = [];
        await Promise.all(newNames.map(async (name) => {
          const clean = name.toLowerCase().replace(/[^a-z0-9]/g, '');
          let status: 'available' | 'taken' | 'unknown';
          try {
            const r = await fetch(`/api/check-domain?name=${encodeURIComponent(clean)}`);
            const data = await r.json();
            status = data.available === true ? 'available' : data.available === false ? 'taken' : 'unknown';
            // Even when the exact name is taken, the server already computed a
            // deterministic domain variant (La-prefix/doubled-letter/+e/+s) for
            // free — surface it too instead of throwing that lookup away, same
            // fix as the guaranteed layer above but for AI-suggested candidates.
            if (status === 'taken' && data.variant) {
              const variantName = (data.variant.domain as string).replace(/\.com$/i, '');
              const properCased = variantName.charAt(0).toUpperCase() + variantName.slice(1);
              if (!seen.has(properCased)) {
                seen.add(properCased);
                extraVariants.push(properCased);
                availabilityMap[properCased] = 'available';
              }
            }
          } catch {
            status = 'unknown';
          }
          availabilityMap[name] = status;
          setAlternativeAvailability(prev => ({ ...prev, [name]: status }));
        }));
        if (extraVariants.length > 0) {
          orderedNames.push(...extraVariants);
          setAlternativeNames([...orderedNames]);
          setAlternativeAvailability(prev => ({
            ...prev,
            ...Object.fromEntries(extraVariants.map(n => [n, 'available' as const])),
          }));
        }
      }

      const finalAvailable = orderedNames.filter(n => availabilityMap[n] === 'available').length;
      if (finalAvailable === 0) setAlternativesExhausted(true);
    } catch (err) {
      console.error('Alternative generation error:', err);
    } finally {
      setGeneratingAlternatives(false);
    }
  };

  // The guest banner wraps to 2 lines on narrow screens, so its real height
  // varies — measure it instead of assuming a fixed 48px, otherwise the
  // sticky header/sidebar below it (pinned to that guessed offset) ends up
  // sitting underneath the banner and gets visually clipped by it.
  useEffect(() => {
    if (!isGuest || !guestBannerRef.current) { setFixedTopOffset(0); return; }
    const el = guestBannerRef.current;
    const update = () => setFixedTopOffset(el.offsetHeight);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, [isGuest]);

  // Visible elapsed-time counter while generating — generation can legitimately
  // take 20-180s+ (Gemini latency + retries), and a silent spinner is exactly
  // what made a slow-but-working request read as "hung" before.
  useEffect(() => {
    if (!loading) { setElapsedSeconds(0); return; }
    const interval = setInterval(() => setElapsedSeconds(s => s + 1), 1000);
    return () => clearInterval(interval);
  }, [loading]);

  // Soft, skippable prompt to capture a phone number once a report is ready —
  // never at signup. Only for real accounts (name+email already exist via
  // Google); guests have no durable identity worth texting.
  useEffect(() => {
    if (!user || isGuest || userPhone || parsedNames.length === 0 || loading) return;
    if (sessionStorage.getItem('sl_phone_prompt_dismissed') === '1') return;
    setShowPhonePrompt(true);
  }, [user, isGuest, userPhone, parsedNames, loading]);

  const handleSkipPhonePrompt = () => {
    sessionStorage.setItem('sl_phone_prompt_dismissed', '1');
    setShowPhonePrompt(false);
  };

  const handleSavePhone = async () => {
    const clean = phoneInput.trim();
    if (!/^[0-9+\-() ]{7,19}$/.test(clean)) {
      toast.error('That doesn\'t look like a valid phone number.');
      return;
    }
    if (!user) return;
    setSavingPhone(true);
    try {
      await updateDoc(doc(db, 'users', user.uid), { phone: clean });
      setUserPhone(clean);
      setShowPhonePrompt(false);
      toast.success("Got it — we'll text you when it's ready.", {
        style: { background: '#050505', color: '#CCFF00', border: '1px solid #CCFF00' },
      });
    } catch (err) {
      console.error('Failed to save phone:', err);
      toast.error('Could not save that number. Please try again.');
    } finally {
      setSavingPhone(false);
    }
  };

  // Save name history to sessionStorage when new names are generated
  useEffect(() => {
    if (parsedNames.length === 0) return;
    setNameHistory(prev => {
      const entry = { names: parsedNames, prompt: productDescription.slice(0, 60), ts: Date.now() };
      const next = [entry, ...prev.filter(e => e.prompt !== entry.prompt)].slice(0, 15);
      sessionStorage.setItem('sl_history', JSON.stringify(next));
      return next;
    });
  }, [parsedNames]);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (currentUser) => {
      setUser(currentUser);
      setIsAuthReady(true);

      if (currentUser && currentUser.isAnonymous) {
        toast.success('Guest session started — your runs are saved to this browser.', {
          style: { background: '#050505', color: '#CCFF00', border: '1px solid #CCFF00' }
        });
        // No `users/{uid}` doc for anonymous sessions: it has no email, and
        // the Firestore rules require one — skip rather than fail silently.
      } else if (currentUser) {
        toast.success(`Welcome, ${currentUser.displayName || currentUser.email?.split('@')[0] || 'User'}!`, {
          style: { background: '#050505', color: '#CCFF00', border: '1px solid #CCFF00' }
        });
        try {
          const userRef = doc(db, 'users', currentUser.uid);
          const userSnap = await getDoc(userRef);
          if (!userSnap.exists()) {
            await setDoc(userRef, {
              uid: currentUser.uid,
              email: currentUser.email,
              role: 'client',
              createdAt: serverTimestamp()
            });
          } else {
            setUserPhone(userSnap.data().phone ?? null);
          }
        } catch (error) {
          console.error('Failed to create user doc:', error);
        }
      }
    });
    return () => unsubscribe();
  }, []);

  useEffect(() => {
    if (!isAuthReady || !user) return;

    let unsubProjects: (() => void) | undefined;

    try {
      const qProjects = query(
        collection(db, 'projects'),
        where('userId', '==', user.uid),
        orderBy('createdAt', 'desc')
      );

      unsubProjects = onSnapshot(qProjects, (snapshot) => {
        const projData = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        setProjects(projData);
      }, (error) => {
        console.error('Projects query error:', error);
      });
    } catch (error) {
      console.error('Firestore query setup error:', error);
    }

    return () => {
      if (unsubProjects) unsubProjects();
    };
  }, [user, isAuthReady]);

  // Post-Stripe-redirect: detect payment_success param
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const ps = params.get('payment_success');
    if (ps === 'report') {
      const credits = PAID_SEARCH_PACK_SIZE;
      sessionStorage.setItem('sl_paid_credits', String(credits));
      setPaidCredits(credits);
      setShowPaywall(false);
      toast.success(`Payment confirmed — ${credits} searches unlocked.`, { style: { background: '#050505', color: '#CCFF00', border: '1px solid #CCFF00' } });
      window.history.replaceState({}, '', window.location.pathname);
    } else if (ps === 'pro') {
      setIsPro(true);
      setShowPaywall(false);
      toast.success('Pro unlocked — unlimited reports active.', { style: { background: '#050505', color: '#CCFF00', border: '1px solid #CCFF00' } });
      window.history.replaceState({}, '', window.location.pathname);
    }
  }, []);

  // Check subscription status for logged-in users
  useEffect(() => {
    if (!user) return;
    const checkStatus = async () => {
      try {
        const token = await user.getIdToken();
        const r = await fetch('/api/stripe/status', { headers: { Authorization: `Bearer ${token}` } });
        const data = await r.json();
        if (data.active) setIsPro(true);
      } catch {}
    };
    checkStatus();
  }, [user]);

  const handleCheckout = async (plan: 'report' | 'pro') => {
    if (!user || isGuest) {
      setShowPaywall(false);
      setShowAccountModal(true);
      return;
    }
    setPaywallLoading(plan);
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (user) headers['Authorization'] = `Bearer ${await user.getIdToken()}`;
      const r = await fetch('/api/stripe/checkout', { method: 'POST', headers, body: JSON.stringify({ plan }) });
      const data = await r.json();
      if (data.url) window.location.href = data.url;
      else throw new Error(data.error || 'No checkout URL returned');
    } catch (e: any) {
      toast.error(e.message || 'Could not start checkout. Please try again.');
    } finally {
      setPaywallLoading(null);
    }
  };

  const handleShowCreateAccount = () => {
    setShowPaywall(false);
    setShowAccountModal(true);
  };

  const handleManageBilling = async () => {
    if (!user) return;
    try {
      const token = await user.getIdToken();
      const r = await fetch('/api/stripe/portal', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } });
      const data = await r.json();
      if (data.url) window.location.href = data.url;
    } catch { toast.error('Could not open billing portal.'); }
  };

  const handleLoginWithGoogle = async (event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    try {
      await loginWithGoogle();
    } catch (error) {
      console.error('Google sign-in failed:', error);
      toast.error('Google authentication failed. Please try again.');
    }
  };

  const handleLoginAsGuest = async (event?: MouseEvent<HTMLButtonElement>) => {
    event?.preventDefault();
    event?.stopPropagation();
    try {
      await loginAsGuest();
    } catch (error) {
      console.error('Anonymous sign-in failed:', error);
      toast.error('Could not start a guest session. Please try again.');
    }
  };

  const speakName = (name: string) => {
    if (!window.speechSynthesis) return;
    window.speechSynthesis.cancel();
    const utt = new SpeechSynthesisUtterance(name.toLowerCase());
    utt.rate = 0.75;
    utt.pitch = 1;
    window.speechSynthesis.speak(utt);
  };

  const handleExport = () => window.print();

  const handleEvolve = async (name: string) => {
    setEvolveTarget(name);
    setEvolveResponse('');
    setParsedEvolvedNames([]);
    setEvolveLoading(true);
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (user) headers['Authorization'] = `Bearer ${await user.getIdToken()}`;
      const res = await fetch('/api/evolve', {
        method: 'POST',
        headers,
        body: JSON.stringify({ name, productDescription, targetAudience }),
      });
      if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.error || `HTTP ${res.status}`); }
      const reader = res.body?.getReader();
      if (!reader) throw new Error('No stream');
      const dec = new TextDecoder();
      let buf = '', full = '';
      while (true) {
        const { done, value } = await readSSEChunk(reader);
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split('\n\n');
        buf = lines.pop() || '';
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const d = line.slice(6);
          if (d === '[DONE]') continue;
          try { const p = JSON.parse(d); if (p.text) { full += p.text; setEvolveResponse(prev => prev + p.text); } } catch {}
        }
      }
      const ms = parseEvolvedNames(full);
      setParsedEvolvedNames(ms);
    } catch (err) {
      toast.error('Evolution failed. Please try again.');
      console.error('Evolve error:', err);
    } finally {
      setEvolveLoading(false);
    }
  };

  const checkDomainAvailable = async (name: string): Promise<'available' | 'taken' | 'unknown'> => {
    const clean = name.toLowerCase().replace(/[^a-z0-9]/g, '');
    try {
      const r = await fetch(`/api/check-domain?name=${encodeURIComponent(clean)}`);
      const data = await r.json();
      return data.available === true ? 'available' : data.available === false ? 'taken' : 'unknown';
    } catch {
      return 'unknown';
    }
  };

  // Create → Invent → Implement: pulls a raw candidate pool per phase from
  // /api/generate-pool, checks real domain availability for all of it up front,
  // and picks the first available candidate per phase — falling back to one
  // widened /api/evolve retry (excluding everything already seen) if an entire
  // phase's pool is taken, and only then to the best candidate anyway. This
  // runs BEFORE the full rationale is written, so the primary 3 names are
  // usually pre-verified as registerable instead of discovered taken after the
  // fact.
  const selectAvailableNames = async (
    headers: Record<string, string>
  ): Promise<{ phase1: string; phase2: string; phase3: string }> => {
    const poolRes = await fetch('/api/generate-pool', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        productDescription,
        positioningStatement,
        targetAudience,
        additionalContext,
        thinkingLevel,
        competitors: competitors.trim() || undefined,
      }),
    });
    if (!poolRes.ok) throw new Error('Failed to generate candidate pool');
    const { text } = await poolRes.json();
    const pool = parseNamePool(text || '');

    const phases: Array<'phase1' | 'phase2' | 'phase3'> = ['phase1', 'phase2', 'phase3'];
    const allCandidates = phases.flatMap((p) => pool[p]);

    const availability: Record<string, 'available' | 'taken' | 'unknown'> = {};
    await Promise.all(allCandidates.map(async (name) => {
      availability[name] = await checkDomainAvailable(name);
    }));

    const winners = { phase1: '', phase2: '', phase3: '' };
    for (const phase of phases) {
      const candidates = pool[phase];
      if (candidates.length === 0) continue;

      const firstAvailable = candidates.find((n) => availability[n] === 'available');
      if (firstAvailable) {
        winners[phase] = firstAvailable;
        continue;
      }

      // Entire phase pool is taken — one widened retry, excluding everything seen so far.
      try {
        const retryNames = await fetchEvolvedVariants(headers, candidates[0], allCandidates, 'wide');
        const retryAvailability: Record<string, 'available' | 'taken' | 'unknown'> = {};
        await Promise.all(retryNames.map(async (n) => { retryAvailability[n] = await checkDomainAvailable(n); }));
        winners[phase] = retryNames.find((n) => retryAvailability[n] === 'available') || candidates[0];
      } catch (err) {
        console.error('Pool retry error:', err);
        winners[phase] = candidates[0];
      }
    }
    return winners;
  };

  const handleGenerate = async () => {
    if (!productDescription.trim() || !targetAudience.trim() || !user) {
      toast.error('Please provide a product description and target audience.');
      return;
    }

    const positioningWordCount = positioningStatement.trim().split(/\s+/).filter(Boolean).length;
    if (!positioningStatement.trim()) {
      toast.error('Add a one-sentence positioning statement — what strategic claim should every name serve?');
      return;
    }
    if (positioningWordCount > 30) {
      toast.error(`Positioning statement must be 30 words or fewer (currently ${positioningWordCount}).`);
      return;
    }

    // Paywall gate: after FREE_SEARCH_LIMIT free searches, require an account + payment.
    // Disabled in dev builds (import.meta.env.DEV) so the app can be tested
    // end-to-end without Stripe/DB configured — stays enforced in production.
    if (!import.meta.env.DEV && shouldShowPaywall({ freeReportsUsed, freeLimit: FREE_SEARCH_LIMIT, isPro, paidCredits })) {
      setShowPaywall(true);
      return;
    }

    setLoading(true);
    setGenerationStage('screening');
    setResponse('');
    setCurrentProjectId(null);
    setDomainStatus('idle');
    setSelectedName('');
    setIsMobileMenuOpen(false);
    setApiKeyError(false);

    let fullResponse = '';

    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (user) {
        headers['Authorization'] = `Bearer ${await user.getIdToken()}`;
      }

      // Create → Invent: pick real, availability-checked names before writing
      // any rationale, instead of discovering after the fact that all 3 are taken.
      const lockedNames = await selectAvailableNames(headers);
      setGenerationStage('writing');

      const response = await fetch('/api/generate', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          productDescription,
          positioningStatement,
          targetAudience,
          additionalContext,
          thinkingLevel,
          competitors: competitors.trim() || undefined,
          lockedNames,
        }),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error || `HTTP error! status: ${response.status}`);
      }

      const reader = response.body?.getReader();
      if (!reader) throw new Error("Failed to initialize stream reader");

      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await readSSEChunk(reader);
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n\n');
        
        // Keep the last potentially incomplete chunk in the buffer
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const dataStr = line.slice(6);
            if (dataStr === '[DONE]') continue;
            
            let data;
            try {
              data = JSON.parse(dataStr);
            } catch (e) {
              console.error('Error parsing SSE data:', e);
              continue;
            }

            if (data.error) {
              throw new Error(data.error);
            }
            if (data.text) {
              fullResponse += data.text;
              setResponse(prev => prev + data.text);
            }
          }
        }
      }

      if (user) {
        try {
          const docRef = await addDoc(collection(db, 'projects'), {
            userId: user.uid,
            productDescription,
            positioningStatement,
            targetAudience,
            additionalContext,
            thinkingLevel,
            generatedContent: fullResponse,
            createdAt: serverTimestamp()
          });
          setCurrentProjectId(docRef.id);
          toast.success('Project saved to your archive.', {
            style: { background: '#050505', color: '#CCFF00', border: '1px solid #CCFF00' }
          });
        } catch (error) {
          toast.error('Failed to save project to history.');
          console.error('Firestore save error:', error);
        }
      }

      // Track paywall usage
      if (freeReportsUsed < FREE_SEARCH_LIMIT) {
        const next = freeReportsUsed + 1;
        setFreeReportsUsed(next);
        sessionStorage.setItem('sl_free_count', String(next));
      } else if (paidCredits > 0) {
        // Consume one search from the paid pack
        const remaining = paidCredits - 1;
        setPaidCredits(remaining);
        sessionStorage.setItem('sl_paid_credits', String(remaining));
      }

    } catch (error) {
      console.error('Generation error:', error);
      const errorMessage = error instanceof Error ? error.message : String(error);
      
      if (errorMessage.includes('API_KEY_MISSING')) {
        setApiKeyError(true);
        setResponse('');
      } else if (errorMessage.includes('API key not valid') || errorMessage.includes('API_KEY_INVALID')) {
        setResponse(`**API Key Needs Attention**\n\nThe API key you selected couldn't be authorized. Click the fingerprint icon in the sidebar to select a different key or create a new one.`);
        toast.error("That API key isn't working — pick another one from the sidebar.");
      } else if (errorMessage.includes('Requested entity was not found') || errorMessage.includes('has not been used in project')) {
        setResponse(`**One More Setup Step**\n\nThe Gemini API isn't enabled yet on the Google Cloud Project you selected. Head to the Google Cloud Console, select your project, and enable the **Generative Language API** — then you're good to go.`);
        toast.error('Gemini API needs to be enabled on this project.');
      } else if (errorMessage.includes('Unauthorized')) {
        setResponse(`**Please Log In Again**\n\nYour session has expired. Log back in and you can pick up right where you left off.`);
        toast.error('Your session expired — please log in again.');
      } else if (errorMessage.includes('Too many requests')) {
        setResponse(`**Just a Quick Breather**\n\nYou're generating names a bit fast. Wait a few seconds and try again.`);
        toast.error("You're generating names a bit fast — give it a few seconds and try again.");
      } else {
        setResponse(`**Taking Longer Than Expected**\n\nWe hit a snag reaching the AI engine. This is usually a brief hiccup with the AI service or network connection — please wait a moment and try again. If it keeps happening, try adjusting your inputs or thinking level.`);
        toast.error("Generation hit a snag — please try again.");
      }
    } finally {
      setLoading(false);
      setGenerationStage('idle');
    }
  };

  // Real RDAP-backed check — same endpoint/retry logic used for the automatic
  // domain screening elsewhere. No pricing, no brokerage, no payment: we have
  // no real registrar/broker integration, so we don't claim to have one.
  const checkDomain = async () => {
    if (!selectedName) return;
    setDomainStatus('checking');
    setDomainVariant(null);
    const clean = selectedName.toLowerCase().replace(/[^a-z0-9]/g, '');
    try {
      const r = await fetch(`/api/check-domain?name=${encodeURIComponent(clean)}`);
      const data = await r.json();
      setDomainStatus(data.available === true ? 'available' : data.available === false ? 'taken' : 'unknown');
      setDomainVariant(data.variant ?? null);
    } catch {
      setDomainStatus('unknown');
    }
  };

  // Preliminary trademark screen (see /api/check-trademark in server.ts for
  // why this can never be "clearance" — the disclaimer text comes straight
  // from the server response so client and server can't drift out of sync).
  const checkTrademark = async () => {
    if (!selectedName) return;
    setTrademarkStatus('checking');
    setTrademarkMatches([]);
    setTrademarkError('');
    try {
      const r = await fetch(`/api/check-trademark?name=${encodeURIComponent(selectedName)}`);
      const data = await r.json();
      setTrademarkDisclaimer(data.disclaimer || '');
      if (!r.ok) {
        setTrademarkStatus('unavailable');
        setTrademarkError(data.error || 'Trademark screening is unavailable right now.');
        return;
      }
      setTrademarkStatus(data.risk);
      setTrademarkMatches(data.matches || []);
    } catch {
      setTrademarkStatus('unavailable');
      setTrademarkError('Trademark screening is unavailable right now.');
    }
  };

  const toggleFavorite = (name: string) => {
    setFavorites(prev => {
      const next = prev.includes(name) ? prev.filter(n => n !== name) : [...prev, name];
      localStorage.setItem('sl_favorites', JSON.stringify(next));
      return next;
    });
  };

  const handleShareReport = () => {
    const params = new URLSearchParams();
    if (productDescription) params.set('d', productDescription);
    if (targetAudience) params.set('a', targetAudience);
    if (additionalContext) params.set('c', additionalContext);
    const url = `${window.location.origin}${window.location.pathname}?${params.toString()}`;
    navigator.clipboard.writeText(url).then(() => {
      toast.success('Shareable link copied to clipboard!', { style: { background: '#050505', color: '#CCFF00', border: '1px solid #CCFF00' } });
    });
  };

  const handleBrandStory = async (name: string) => {
    setBrandStoryTarget(name);
    setBrandStoryText('');
    setBrandStoryLoading(true);
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (user) headers['Authorization'] = `Bearer ${await user.getIdToken()}`;
      const res = await fetch('/api/brand-story', {
        method: 'POST', headers,
        body: JSON.stringify({ name, productDescription, targetAudience, additionalContext }),
      });
      if (!res.ok) throw new Error('Failed to generate brand story');
      const reader = res.body?.getReader();
      if (!reader) throw new Error('No stream');
      const decoder = new TextDecoder();
      let buf = '';
      while (true) {
        const { done, value } = await readSSEChunk(reader);
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split('\n\n');
        buf = lines.pop() || '';
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const d = line.slice(6);
          if (d === '[DONE]') continue;
          try {
            const parsed = JSON.parse(d);
            if (parsed.text) setBrandStoryText(prev => prev + parsed.text);
          } catch {}
        }
      }
    } catch {
      toast.error('Brand story generation failed.');
    } finally {
      setBrandStoryLoading(false);
    }
  };

  const loadProject = (project: any) => {
    setProductDescription(project.productDescription);
    setPositioningStatement(project.positioningStatement || '');
    setTargetAudience(project.targetAudience);
    setAdditionalContext(project.additionalContext || '');
    setThinkingLevel(project.thinkingLevel);
    setSelectedInspiration(null);
    setResponse(project.generatedContent);
    setCurrentProjectId(project.id);
    setDomainStatus('idle');
    setSelectedName('');
    setIsMobileMenuOpen(false);
  };

  if (!user) {
    return (
      <div className="min-h-screen bg-white text-neutral-700 selection:bg-[#7CB800] selection:text-white overflow-x-hidden [font-family:-apple-system,BlinkMacSystemFont,'Segoe_UI',Inter,Roboto,sans-serif]">
        {/* Navigation */}
        <nav className="sticky top-0 left-0 w-full border-b border-neutral-200 bg-white z-50">
          <div className="max-w-6xl mx-auto px-6 min-h-16 py-3 flex flex-wrap items-center justify-between gap-y-2">
            <button
              onClick={() => { window.location.href = '/'; }}
              className="flex items-center gap-2.5 hover:opacity-70 transition-opacity flex-shrink-0"
            >
              <div className="w-7 h-7 rounded-full bg-[#7CB800] flex items-center justify-center text-white flex-shrink-0">
                <Terminal className="w-4 h-4" />
              </div>
              <span className="font-sans font-semibold text-neutral-900 tracking-tight text-base whitespace-nowrap">NamingStorm</span>
            </button>

            <div className="flex items-center gap-5 flex-shrink-0">
              {window.aistudio?.openSelectKey && (
                <button
                  onClick={async () => {
                    try {
                      await window.aistudio?.openSelectKey();
                      toast.success('API key selected successfully.');
                    } catch (e) {
                      toast.error('Failed to select API key.');
                    }
                  }}
                  className="hidden md:flex items-center gap-2 text-sm text-neutral-500 hover:text-neutral-900 transition-colors"
                >
                  <Fingerprint className="w-4 h-4" />
                  <span>Select API Key</span>
                </button>
              )}
              {user ? (
                <div className="flex items-center gap-3">
                  {user.photoURL && (
                    <img src={user.photoURL} alt="" className="w-6 h-6 rounded-full" />
                  )}
                  <span className="text-sm text-neutral-600 max-w-[120px] truncate">
                    {user.displayName || user.email?.split('@')[0] || 'User'}
                  </span>
                  <button
                    type="button"
                    onClick={logout}
                    className="text-sm text-neutral-400 hover:text-red-500 transition-colors"
                  >
                    Log out
                  </button>
                </div>
              ) : (
                <>
                  <button
                    type="button"
                    onClick={handleLoginAsGuest}
                    className="text-sm text-neutral-500 hover:text-neutral-900 transition-colors whitespace-nowrap"
                  >
                    Continue as guest
                  </button>
                  <button
                    type="button"
                    onClick={handleLoginWithGoogle}
                    className="bg-[#7CB800] text-white rounded-full px-5 py-2 text-sm font-medium hover:bg-[#6ba300] transition-colors whitespace-nowrap"
                  >
                    Sign in
                  </button>
                </>
              )}
            </div>
          </div>
        </nav>

        {/* Hero Section */}
        <section className="pt-24 pb-20 px-6">
          <div className="max-w-4xl mx-auto text-center">
            <div className="inline-flex items-center gap-2 rounded-full border border-neutral-200 bg-neutral-50 px-4 py-1.5 mb-8">
              <span className="relative flex h-1.5 w-1.5">
                <span className="motion-safe:animate-ping absolute inline-flex h-full w-full rounded-full bg-[#7CB800] opacity-75"></span>
                <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-[#7CB800]"></span>
              </span>
              <span className="text-xs font-medium text-neutral-500">Version 3.1.4 · Live</span>
            </div>

            <h1 className="[font-family:inherit] text-5xl md:text-6xl lg:text-7xl font-semibold text-neutral-900 leading-tight tracking-tight mb-6">
              The AI naming engine<br/>
              <span className="text-[#7CB800]">for founders who ship.</span>
            </h1>
            <p className="text-lg md:text-xl text-neutral-500 max-w-2xl mx-auto mb-10 leading-relaxed">
              Move beyond brainstorming. NamingStorm engineers category-defining, highly acquirable brand names — with phonetic scoring, trademark screening, and domain checks built in.
            </p>

            <div className="flex flex-col sm:flex-row gap-3 items-center justify-center">
              <button
                type="button"
                onClick={handleLoginWithGoogle}
                className="bg-[#7CB800] text-white font-medium rounded-full py-3.5 px-8 hover:bg-[#6ba300] active:scale-[0.98] transition-all flex items-center justify-center gap-2 text-sm"
              >
                Get started <ChevronRight className="w-4 h-4" />
              </button>
              <button
                type="button"
                onClick={handleLoginAsGuest}
                className="border border-neutral-300 text-neutral-700 font-medium rounded-full py-3.5 px-8 hover:border-neutral-400 hover:bg-neutral-50 active:scale-[0.98] transition-all flex items-center justify-center gap-2 text-sm"
              >
                Try as guest
              </button>
            </div>
          </div>
        </section>

        {/* Advantages Section */}
        <section className="py-20 px-6 bg-neutral-50">
          <div className="max-w-6xl mx-auto">
            <div className="text-center mb-16">
              <h2 className="[font-family:inherit] text-3xl md:text-4xl font-semibold text-neutral-900 leading-tight tracking-tight mb-4">Built to replace the whiteboard session</h2>
              <p className="text-neutral-500 max-w-xl mx-auto">Human brainstorming is constrained by cognitive bias and limited linguistic reach. NamingStorm runs a structured naming methodology instead.</p>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
              {/* Advantage 1 */}
              <div className="bg-white rounded-2xl p-8 border border-neutral-200 hover:border-neutral-900 transition-colors">
                <div className="w-11 h-11 rounded-full bg-neutral-100 flex items-center justify-center mb-6">
                  <Zap className="w-5 h-5 text-neutral-700" />
                </div>
                <h3 className="[font-family:inherit] text-lg font-semibold text-neutral-900 leading-snug mb-2">Algorithmic precision</h3>
                <p className="text-neutral-500 text-sm leading-relaxed">
                  We don't rely on "eureka" moments. Names are engineered using linguistic frameworks and phonetic scoring to guarantee memorability.
                </p>
              </div>

              {/* Advantage 2 */}
              <div className="bg-white rounded-2xl p-8 border border-neutral-200 hover:border-neutral-900 transition-colors">
                <div className="w-11 h-11 rounded-full bg-neutral-100 flex items-center justify-center mb-6">
                  <Globe className="w-5 h-5 text-neutral-700" />
                </div>
                <h3 className="[font-family:inherit] text-lg font-semibold text-neutral-900 leading-snug mb-2">Global pre-clearance</h3>
                <p className="text-neutral-500 text-sm leading-relaxed">
                  Every generated name is cross-referenced against trademark databases and domain registries, cutting legal friction before it starts.
                </p>
              </div>

              {/* Advantage 3 */}
              <div className="bg-white rounded-2xl p-8 border border-neutral-200 hover:border-neutral-900 transition-colors">
                <div className="w-11 h-11 rounded-full bg-neutral-100 flex items-center justify-center mb-6">
                  <Activity className="w-5 h-5 text-neutral-700" />
                </div>
                <h3 className="[font-family:inherit] text-lg font-semibold text-neutral-900 leading-snug mb-2">Infinite iteration</h3>
                <p className="text-neutral-500 text-sm leading-relaxed">
                  Traditional agencies provide 5-10 options after weeks of work. Our engine provides hundreds of targeted options in seconds.
                </p>
              </div>
            </div>
          </div>
        </section>

        {/* About Section */}
        <section className="py-20 px-6 bg-white">
          <div className="max-w-3xl mx-auto text-center">
            <p className="text-xs font-medium text-neutral-400 uppercase tracking-wider mb-4">About NamingStorm</p>
            <h2 className="[font-family:inherit] text-3xl md:text-4xl font-semibold text-neutral-900 leading-tight tracking-tight mb-6">Built for founders, powered by the engine.</h2>
            <p className="text-neutral-500 max-w-2xl mx-auto leading-relaxed">
              NamingStorm delivers AI-powered brand names, domain signals, and storytelling in seconds. It's powered by the NamingStorm Engine, a naming architecture that combines phonetic scoring, semantic indexing, and trademark-aware strategy.
            </p>
          </div>
        </section>

        {/* Footer CTA */}
        <section className="py-24 px-6 bg-neutral-50 text-center">
          <div className="max-w-2xl mx-auto">
            <h2 className="[font-family:inherit] text-3xl md:text-5xl font-semibold text-neutral-900 leading-tight tracking-tight mb-6">Ready when you are.</h2>
            <p className="text-neutral-500 mb-10">Secure your category-defining brand name today.</p>
            <div className="flex flex-col sm:flex-row gap-3 justify-center">
              <button
                type="button"
                onClick={handleLoginWithGoogle}
                className="bg-[#7CB800] text-white font-medium rounded-full py-3.5 px-8 hover:bg-[#6ba300] transition-colors inline-flex items-center justify-center gap-2 text-sm"
              >
                <LogIn className="w-4 h-4" /> Sign in
              </button>
              <button
                type="button"
                onClick={handleLoginAsGuest}
                className="border border-neutral-300 text-neutral-700 font-medium rounded-full py-3.5 px-8 hover:border-neutral-400 hover:bg-white transition-colors inline-flex items-center justify-center gap-2 text-sm"
              >
                Try as guest
              </button>
            </div>
          </div>
        </section>
      </div>
    );
  }

  return (
    <MotionConfig reducedMotion="user">
    <div style={{ paddingTop: fixedTopOffset }} className="min-h-screen bg-black font-sans flex flex-col md:flex-row relative selection:bg-[#CCFF00] selection:text-black">
      <Toaster position="top-right" />
      <div className="fixed inset-0 bg-[linear-gradient(to_right,#8080800a_1px,transparent_1px),linear-gradient(to_bottom,#8080800a_1px,transparent_1px)] bg-[size:24px_24px] pointer-events-none z-0"></div>
      <div className="fixed top-0 right-0 w-[500px] h-[500px] bg-[#CCFF00] opacity-[0.04] blur-[160px] rounded-full pointer-events-none z-0"></div>

      {/* Guest mode banner */}
      {isGuest && (
        <div ref={guestBannerRef} className="fixed top-0 left-0 w-full z-50 bg-zinc-900 border-b border-zinc-700 px-4 py-3 flex flex-wrap items-center justify-between gap-3">
          <span className="text-xs font-mono text-zinc-400 uppercase tracking-widest min-w-0 truncate">Guest session — saved to this browser only</span>
          <button
            type="button"
            onClick={handleLoginWithGoogle}
            className="text-xs font-mono uppercase tracking-widest text-[#CCFF00] hover:text-white transition-colors whitespace-nowrap flex-shrink-0"
          >
            [ Sign in with Google to save ]
          </button>
        </div>
      )}

      {/* Mobile Header */}
      <div style={{ top: fixedTopOffset }} className="md:hidden flex items-center justify-between p-4 border-b border-zinc-900 bg-[#050505] sticky z-30">
        <div className="flex items-center gap-3 min-w-0">
          <div className="w-8 h-8 bg-[#CCFF00] flex items-center justify-center text-black flex-shrink-0">
            <Terminal className="w-5 h-5" />
          </div>
          <span className="font-display font-extrabold text-white tracking-tight text-base md:text-lg whitespace-nowrap">NamingStorm</span>
        </div>
        <button
          onClick={() => setIsMobileMenuOpen(!isMobileMenuOpen)}
          aria-label={isMobileMenuOpen ? 'Close menu' : 'Open menu'}
          aria-expanded={isMobileMenuOpen}
          className="text-zinc-400 hover:text-white flex-shrink-0 p-2.5 -m-2.5"
        >
          {isMobileMenuOpen ? <X className="w-6 h-6" /> : <Menu className="w-6 h-6" />}
        </button>
      </div>

      {/* Sidebar */}
      <div style={{ top: fixedTopOffset }} className={`w-full md:w-80 border-b md:border-b-0 md:border-r border-zinc-900 bg-[#050505] flex-col h-[calc(100vh-73px)] md:h-screen sticky top-[73px] md:top-0 z-20 ${isMobileMenuOpen ? 'flex fixed inset-x-0' : 'hidden md:flex'}`}>
        <div className="hidden md:flex p-6 border-b border-zinc-900 items-center justify-between">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-8 h-8 bg-[#CCFF00] flex items-center justify-center text-black flex-shrink-0">
              <Terminal className="w-5 h-5" />
            </div>
            <span className="font-display font-extrabold text-white tracking-tight text-lg whitespace-nowrap">NamingStorm</span>
          </div>
          <div className="flex items-center gap-4">
            {window.aistudio?.openSelectKey && (
              <button
                onClick={async () => {
                  try {
                    await window.aistudio?.openSelectKey();
                    toast.success('API key selected successfully.');
                  } catch (e) {
                    toast.error('Failed to select API key.');
                  }
                }}
                className="text-zinc-400 hover:text-[#CCFF00] transition-colors"
                title="Select API Key"
              >
                <Fingerprint className="w-4 h-4" />
              </button>
            )}
            <button onClick={logout} className="text-zinc-400 hover:text-[#CCFF00] transition-colors" title="Logout">
              <LogOut className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Signed-in account indicator */}
        {user && !isGuest ? (
          <div className="hidden md:flex items-center gap-3 px-6 py-3 border-b border-zinc-900">
            {user.photoURL ? (
              <img src={user.photoURL} alt="" className="w-6 h-6 rounded-full flex-shrink-0" />
            ) : (
              <div className="w-6 h-6 rounded-full bg-zinc-800 flex items-center justify-center flex-shrink-0">
                <span className="text-[9px] font-bold text-zinc-300">{(user.displayName || user.email || 'U').charAt(0).toUpperCase()}</span>
              </div>
            )}
            <div className="min-w-0">
              <p className="text-xs text-zinc-200 truncate leading-tight">{user.displayName || user.email?.split('@')[0] || 'Signed in'}</p>
              {user.email && <p className="text-[10px] font-mono text-zinc-500 truncate leading-tight">{user.email}</p>}
            </div>
          </div>
        ) : isGuest ? (
          <div className="hidden md:flex items-center gap-3 px-6 py-3 border-b border-zinc-900">
            <div className="w-6 h-6 rounded-full bg-zinc-800 flex items-center justify-center flex-shrink-0">
              <span className="text-[9px] font-bold text-zinc-400">G</span>
            </div>
            <p className="text-xs font-mono text-zinc-400 uppercase tracking-wider">Guest session</p>
          </div>
        ) : null}

        <div className="flex-1 overflow-y-auto p-5 space-y-8">
          {/* Favorites */}
          {favorites.length > 0 && (
            <div>
              <h3 className="text-[10px] font-mono text-zinc-400 uppercase tracking-[0.2em] mb-4 flex items-center gap-2">
                <Star className="w-3 h-3 text-[#CCFF00]" /> Shortlisted Names
              </h3>
              <div className="flex flex-wrap gap-2">
                {favorites.map(name => (
                  <div key={name} className="flex items-center gap-1 bg-[#CCFF00]/5 border border-[#CCFF00]/20 px-2 py-1 group">
                    <span className="text-xs font-display font-bold text-[#CCFF00] tracking-wide">{name}</span>
                    <button
                      onClick={() => toggleFavorite(name)}
                      aria-label={`Remove ${name} from shortlist`}
                      className="text-zinc-600 hover:text-red-400 transition-colors ml-1 opacity-60 group-hover:opacity-100 p-1.5 -m-1.5"
                    >
                      <X className="w-2.5 h-2.5" />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Session History */}
          {nameHistory.length > 0 && (
            <div>
              <button
                onClick={() => setIsHistoryOpen(v => !v)}
                className="w-full flex items-center justify-between text-[10px] font-mono text-zinc-400 uppercase tracking-[0.2em] mb-3 hover:text-white transition-colors"
              >
                <span className="flex items-center gap-2"><Clock className="w-3 h-3" /> Session History ({nameHistory.length})</span>
                {isHistoryOpen ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
              </button>
              {isHistoryOpen && (
                <div className="space-y-2">
                  {nameHistory.map((entry, i) => (
                    <div key={i} className="p-3 border border-zinc-900 hover:border-zinc-700 cursor-pointer transition-colors" onClick={() => {
                      entry.names.forEach(n => {/* just display */});
                      toast.success('History loaded — scroll to Name Intelligence Report.', { style: { background: '#050505', color: '#CCFF00', border: '1px solid #CCFF00' } });
                    }}>
                      <p className="text-[10px] font-mono text-zinc-400 truncate">{entry.prompt}…</p>
                      <div className="flex flex-wrap gap-1 mt-2">
                        {entry.names.map(n => (
                          <span key={n} className="text-[9px] font-display font-bold text-zinc-300 bg-zinc-900 px-1.5 py-0.5">{n}</span>
                        ))}
                      </div>
                      <p className="text-[8px] font-mono text-zinc-600 mt-2">{new Date(entry.ts).toLocaleTimeString()}</p>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}


          {/* History */}
          <div>
            <h3 className="text-[10px] font-mono text-zinc-400 uppercase tracking-[0.2em] mb-4 flex items-center gap-2">
              <History className="w-3 h-3" /> Project History
            </h3>
            <div className="space-y-2">
              {projects.map(proj => (
                <button 
                  key={proj.id}
                  onClick={() => loadProject(proj)}
                  className={`w-full text-left p-4 border transition-all relative ${currentProjectId === proj.id ? 'bg-zinc-900/50 border-zinc-700' : 'border-transparent hover:bg-zinc-900/30'}`}
                >
                  {currentProjectId === proj.id && <div className="absolute left-0 top-1/2 -translate-y-1/2 w-1 h-4 bg-[#CCFF00]"></div>}
                  <p className="text-sm text-zinc-200 truncate font-medium">{proj.productDescription || 'Untitled Project'}</p>
                  <p className="text-[10px] text-zinc-400 font-mono mt-2 truncate uppercase tracking-wider">{proj.targetAudience}</p>
                </button>
              ))}
              {projects.length === 0 && (
                <p className="text-xs text-zinc-500 font-mono italic px-4">No projects yet.</p>
              )}
            </div>
          </div>
        </div>
        
        {/* Mobile Logout (bottom of sidebar) */}
        <div className="md:hidden p-4 border-t border-zinc-900">
          <button onClick={logout} className="w-full flex items-center justify-center gap-2 text-zinc-300 hover:text-white py-3 border border-zinc-800">
            <LogOut className="w-4 h-4" />
            <span className="text-xs font-mono uppercase tracking-widest">Disconnect</span>
          </button>
        </div>
      </div>

      {/* Main Content */}
      <div className="flex-1 flex flex-col h-auto md:h-screen overflow-hidden relative z-10">
        <div className="flex-1 overflow-y-auto p-4 md:p-8 lg:p-12">
          <div className="max-w-6xl mx-auto grid grid-cols-1 xl:grid-cols-12 gap-8 lg:gap-12">
            
            {/* Left Panel: Controls */}
            <div className="xl:col-span-4 space-y-6">
              <div className="border border-zinc-800/60 bg-[#050505]/80 backdrop-blur-sm p-6 lg:p-8 relative">
                {/* Tech accents */}
                <div className="absolute top-0 left-0 w-full h-[1px] bg-gradient-to-r from-transparent via-[#CCFF00]/30 to-transparent"></div>
                
                <div className="space-y-8">
                  <div className="space-y-3">
                    <label className="text-[10px] font-mono text-[#CCFF00] uppercase tracking-[0.2em] flex items-center gap-2">
                      <Activity className="w-3 h-3" /> Product Description
                    </label>
                    <textarea 
                      value={productDescription}
                      onChange={(e) => setProductDescription(e.target.value)}
                      placeholder="e.g., A high-speed VPN that doesn't log user data..."
                      className="w-full bg-zinc-900 border border-zinc-600 p-4 text-sm text-zinc-100 focus:outline-none focus:border-[#CCFF00] focus:ring-1 focus:ring-[#CCFF00]/50 transition-all min-h-[140px] resize-y font-mono placeholder:text-zinc-500 shadow-inner"
                    />
                    
                    {/* Inspiration Chips */}
                    <div className="pt-2">
                      <p className="text-[10px] text-zinc-400 font-mono uppercase tracking-widest mb-2">Need inspiration? Try a category:</p>
                      <div className="flex flex-wrap gap-2">
                        {INSPIRATION_IDEAS.map((idea, idx) => (
                          <button
                            key={idx}
                            onClick={() => {
                              if (selectedInspiration === idea.label) {
                                setSelectedInspiration(null);
                                setProductDescription('');
                                setTargetAudience('');
                                setAdditionalContext('');
                              } else {
                                setSelectedInspiration(idea.label);
                                setProductDescription(idea.desc);
                                setTargetAudience(idea.audience);
                                setAdditionalContext(idea.context || '');
                              }
                            }}
                            className={`text-[10px] font-mono px-2 py-1 active:scale-95 transition-all border ${
                              selectedInspiration === idea.label
                                ? 'bg-[#CCFF00]/20 border-[#CCFF00] text-[#CCFF00]'
                                : 'text-zinc-300 bg-zinc-900/50 border-zinc-700 hover:border-[#CCFF00]/50 hover:text-[#CCFF00]'
                            }`}
                          >
                            {idea.label}
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>

                  <div className="space-y-3">
                    <label className="text-[10px] font-mono text-[#CCFF00] uppercase tracking-[0.2em] flex items-center gap-2">
                      <Compass className="w-3 h-3" /> Target Audience
                    </label>
                    <input 
                      type="text"
                      value={targetAudience}
                      onChange={(e) => setTargetAudience(e.target.value)}
                      placeholder="e.g., Remote workers, digital nomads..."
                      className="w-full bg-zinc-900 border border-zinc-600 p-4 text-sm text-zinc-100 focus:outline-none focus:border-[#CCFF00] focus:ring-1 focus:ring-[#CCFF00]/50 transition-all font-mono placeholder:text-zinc-500 shadow-inner"
                    />
                  </div>

                  <div className="space-y-3">
                    <label className="text-[10px] font-mono text-[#CCFF00] uppercase tracking-[0.2em] flex items-center gap-2">
                      <Sparkles className="w-3 h-3" /> Specific Data / Additional Context
                    </label>
                    <textarea 
                      value={additionalContext}
                      onChange={(e) => setAdditionalContext(e.target.value)}
                      placeholder="e.g., Core values, brand personality, words to avoid, specific themes to explore..."
                      className="w-full bg-zinc-900 border border-zinc-600 p-4 text-sm text-zinc-100 focus:outline-none focus:border-[#CCFF00] focus:ring-1 focus:ring-[#CCFF00]/50 transition-all min-h-[80px] resize-y font-mono placeholder:text-zinc-500 shadow-inner"
                    />
                  </div>

                  <div className="space-y-3">
                    <label className="text-[10px] font-mono text-[#CCFF00] uppercase tracking-[0.2em] flex items-center gap-2">
                      <Target className="w-3 h-3" /> Positioning Statement <span className="text-zinc-500 normal-case tracking-normal">(required, ≤30 words)</span>
                    </label>
                    <input
                      type="text"
                      value={positioningStatement}
                      onChange={(e) => setPositioningStatement(e.target.value)}
                      placeholder="e.g., The only skincare line that proves ocean minerals outperform synthetic actives."
                      className="w-full bg-zinc-900 border border-zinc-600 p-4 text-sm text-zinc-100 focus:outline-none focus:border-[#CCFF00] focus:ring-1 focus:ring-[#CCFF00]/50 transition-all font-mono placeholder:text-zinc-500 shadow-inner"
                    />
                    <p className="text-[9px] text-zinc-500 font-mono">The one strategic claim every generated name must serve — closes the brief before ideation starts.</p>
                  </div>

                  {/* Competitors Input */}
                  <div className="space-y-2">
                    <button
                      onClick={() => setShowCompetitors(v => !v)}
                      className="flex items-center gap-2 text-[10px] font-mono text-zinc-500 hover:text-zinc-200 uppercase tracking-widest transition-colors w-full"
                    >
                      <Users className="w-3 h-3" />
                      {showCompetitors ? 'Hide' : '+ Add'} Competitor Names
                      {showCompetitors ? <ChevronUp className="w-3 h-3 ml-auto" /> : <ChevronDown className="w-3 h-3 ml-auto" />}
                    </button>
                    {showCompetitors && (
                      <div className="space-y-2">
                        <input
                          type="text"
                          value={competitors}
                          onChange={e => setCompetitors(e.target.value)}
                          placeholder="e.g., Stripe, Plaid, Brex (comma-separated)"
                          className="w-full bg-zinc-900 border border-zinc-700 p-3 text-sm text-zinc-100 focus:outline-none focus:border-[#CCFF00]/50 font-mono placeholder:text-zinc-600 shadow-inner"
                        />
                        <p className="text-[9px] font-mono text-zinc-600">AI will study their patterns and generate names that stand apart.</p>
                      </div>
                    )}
                  </div>

                  <div className="space-y-5 pt-4 border-t border-zinc-900">
                    <div className="flex justify-between items-center">
                      <label className="text-[10px] font-mono text-zinc-400 uppercase tracking-[0.2em] flex items-center gap-2">
                        <Zap className="w-3 h-3" /> Approx. Thinking
                      </label>
                      <span className="text-[10px] font-mono text-[#CCFF00] bg-[#CCFF00]/10 px-2 py-1 border border-[#CCFF00]/20">
                        {thinkingLevel}%
                      </span>
                    </div>
                    
                    <input 
                      type="range" 
                      min="0" 
                      max="100" 
                      value={thinkingLevel}
                      onChange={(e) => setThinkingLevel(Number(e.target.value))}
                      className="w-full accent-[#CCFF00] h-1 bg-zinc-900 appearance-none cursor-pointer"
                    />
                    
                    <div className="flex justify-between text-[9px] font-mono text-zinc-500 uppercase tracking-widest">
                      <span>Safe / Workable</span>
                      <span>Bizarre / Abstract</span>
                    </div>
                  </div>

                  <button 
                    onClick={handleGenerate}
                    disabled={loading || !productDescription || !targetAudience || !positioningStatement}
                    className="w-full mt-8 bg-[#CCFF00] hover:bg-[#E6FF00] active:scale-[0.98] text-black font-display font-bold tracking-[0.15em] py-4 px-4 transition-all flex items-center justify-center gap-3 disabled:opacity-50 disabled:cursor-not-allowed disabled:active:scale-100 shadow-[0_0_15px_rgba(204,255,0,0.15)] hover:shadow-[0_0_25px_rgba(204,255,0,0.3)] uppercase text-sm"
                  >
                    {loading ? (
                      <>
                        <Loader2 className="w-4 h-4 animate-spin" />
                        {generationStage === 'screening' ? 'Screening For Available Names...' : 'Processing...'} ({elapsedSeconds}s)
                      </>
                    ) : (
                      <>
                        Initialize Protocol
                      </>
                    )}
                  </button>
                </div>
              </div>
            </div>

            {/* Right Panel: Results & Monetization */}
            <div className="xl:col-span-8 space-y-8">
              <div className="border border-zinc-800/60 bg-[#050505]/80 backdrop-blur-sm p-6 lg:p-10 min-h-[600px] relative">
                {/* Corner accents */}
                <div className="absolute top-0 left-0 w-3 h-3 border-t-2 border-l-2 border-[#CCFF00]/50"></div>
                <div className="absolute top-0 right-0 w-3 h-3 border-t-2 border-r-2 border-[#CCFF00]/50"></div>
                <div className="absolute bottom-0 left-0 w-3 h-3 border-b-2 border-l-2 border-[#CCFF00]/50"></div>
                <div className="absolute bottom-0 right-0 w-3 h-3 border-b-2 border-r-2 border-[#CCFF00]/50"></div>

                {!response && !loading && !apiKeyError ? (
                  <motion.div
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    className="h-full flex flex-col items-center justify-center text-zinc-500 space-y-6 py-32"
                  >
                    <Fingerprint className="w-16 h-16 opacity-20" />
                    <p className="font-mono text-xs uppercase tracking-[0.3em]">Awaiting Input Parameters</p>
                  </motion.div>
                ) : !response && loading ? (
                  <motion.div
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    className="h-full flex flex-col items-center justify-center text-zinc-400 space-y-4 py-32"
                  >
                    <Loader2 className="w-10 h-10 animate-spin text-[#CCFF00]" />
                    <p className="font-mono text-xs uppercase tracking-[0.3em] text-[#CCFF00]">
                      {generationStage === 'screening' ? 'Verifying registerable domains…' : 'Writing your report…'}
                    </p>
                    <p className="font-mono text-[10px] text-zinc-600 uppercase tracking-widest">{elapsedSeconds}s elapsed</p>
                    {elapsedSeconds >= 20 && (
                      <p className="font-mono text-[10px] text-zinc-500 max-w-xs text-center leading-relaxed">
                        Still working — the AI engine occasionally retries a stalled call, which can take up to 3 minutes total. No need to refresh.
                      </p>
                    )}
                  </motion.div>
                ) : apiKeyError ? (
                  <motion.div 
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    className="h-full flex flex-col items-center justify-center text-zinc-400 space-y-6 py-32 text-center max-w-md mx-auto"
                  >
                    <div className="w-16 h-16 rounded-full bg-red-500/10 flex items-center justify-center mb-4">
                      <Fingerprint className="w-8 h-8 text-red-500" />
                    </div>
                    <h3 className="text-xl font-display font-bold text-white uppercase tracking-tight">API Key Required</h3>
                    <p className="text-sm leading-relaxed">
                      The AI engine requires a valid Gemini API key to initialize the protocol. Please select your API key to continue.
                    </p>
                    {window.aistudio?.openSelectKey && (
                      <button
                        onClick={async () => {
                          try {
                            await window.aistudio?.openSelectKey();
                            setApiKeyError(false);
                            toast.success('API key selected! Initializing protocol...', { icon: '🚀' });
                            // Wait a moment for the backend to restart with the new key
                            setTimeout(() => {
                              handleGenerate();
                            }, 2500);
                          } catch (e) {
                            toast.error('Failed to select API key.');
                          }
                        }}
                        className="mt-4 bg-[#CCFF00] text-black font-display font-bold uppercase tracking-[0.15em] py-4 px-8 hover:bg-[#E6FF00] transition-colors flex items-center justify-center gap-3 text-sm shadow-[0_0_20px_rgba(204,255,0,0.2)] hover:shadow-[0_0_30px_rgba(204,255,0,0.4)]"
                      >
                        <Fingerprint className="w-4 h-4" /> Select API Key
                      </button>
                    )}
                  </motion.div>
                ) : (
                  <div>
                    <div className="no-print flex items-center justify-between mb-6 pb-3 border-b border-zinc-900">
                      <p className="text-[10px] font-mono text-zinc-500 uppercase tracking-[0.2em]">Protocol Output</p>
                      <div className="flex gap-2">
                        <button onClick={handleGenerate} disabled={loading} className="flex items-center gap-1.5 text-[10px] font-mono uppercase tracking-widest text-zinc-400 hover:text-white active:scale-95 border border-zinc-800 hover:border-zinc-600 px-3 py-1.5 transition-all disabled:opacity-40 disabled:active:scale-100">
                          <RefreshCw className="w-3 h-3" /> Run Again
                        </button>
                        <button onClick={handleShareReport} className="flex items-center gap-1.5 text-[10px] font-mono uppercase tracking-widest text-zinc-400 hover:text-zinc-200 active:scale-95 border border-zinc-800 hover:border-zinc-600 px-3 py-1.5 transition-all">
                          <Share2 className="w-3 h-3" /> Share
                        </button>
                        <button onClick={handleExport} className="flex items-center gap-1.5 text-[10px] font-mono uppercase tracking-widest text-zinc-400 hover:text-[#CCFF00] active:scale-95 border border-zinc-800 hover:border-[#CCFF00]/50 px-3 py-1.5 transition-all">
                          <Download className="w-3 h-3" /> Export
                        </button>
                      </div>
                    </div>
                    <div className="markdown-body">
                      <Markdown>{response}</Markdown>
                      {loading && (
                        <div className="flex items-center gap-2 mt-8 text-[#CCFF00] font-mono text-sm">
                          <span className="animate-pulse">_</span>
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>

              {/* Name Analysis Cards */}
              <AnimatePresence>
                {!loading && parsedNames.length > 0 && (
                  <motion.div
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -10 }}
                    className="border border-zinc-800/60 bg-[#050505]/80 backdrop-blur-sm p-5 lg:p-6"
                  >
                    <div className="flex items-center gap-2 mb-5">
                      <TrendingUp className="w-3 h-3 text-[#CCFF00]" />
                      <p className="text-[10px] font-mono text-[#CCFF00] uppercase tracking-[0.2em]">Name Intelligence Report</p>
                    </div>
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                      {parsedNames.map((name, i) => {
                        const scores = scoreNameFn(name, domainAvailability[name]);
                        const soundProfile = getSoundProfile(name);
                        const metrics = [
                          { label: 'Phonetic', value: scores.phonetic },
                          { label: 'Trademark', value: scores.trademark },
                          { label: 'Domain', value: scores.domain },
                          { label: 'Category', value: scores.category },
                        ];
                        const isSelected = selectedName === name;
                        return (
                          <div key={i} className={`border p-5 transition-all duration-200 relative group ${isSelected ? 'border-[#CCFF00] bg-[#CCFF00]/5' : 'border-zinc-800 hover:border-zinc-600'}`}>
                            {isSelected && <div className="absolute top-0 left-0 w-1 h-full bg-[#CCFF00]" />}
                            <div className="flex items-start justify-between mb-3">
                              <span className={`font-display font-bold text-xl tracking-wide ${isSelected ? 'text-[#CCFF00]' : 'text-white'}`}>{name}</span>
                              <span className="text-[9px] font-mono text-zinc-600 uppercase mt-1">Phase {i + 1}</span>
                            </div>
                            <div className="flex items-center gap-1.5 mb-4 -mt-2">
                              <span className="text-[9px] font-mono text-zinc-500 uppercase tracking-widest">Sound: {soundProfile.label}</span>
                              {soundProfile.traits.length > 0 && (
                                <span className="text-[9px] font-mono text-[#CCFF00]/70 uppercase tracking-widest">· {soundProfile.traits.join(', ')}</span>
                              )}
                            </div>
                            {/* Real .com availability badge */}
                            {(() => {
                              const avail = domainAvailability[name];
                              if (avail === 'checking') return (
                                <div className="flex items-center gap-1.5 mb-4">
                                  <span className="w-1.5 h-1.5 rounded-full bg-zinc-500 animate-pulse inline-block" />
                                  <span className="text-[9px] font-mono text-zinc-500 uppercase tracking-widest">Checking .com…</span>
                                </div>
                              );
                              if (avail === 'available') return (
                                <div className="flex items-center gap-1.5 mb-4">
                                  <span className="w-1.5 h-1.5 rounded-full bg-[#CCFF00] inline-block" />
                                  <span className="text-[9px] font-mono text-[#CCFF00] uppercase tracking-widest">{name.toLowerCase().replace(/[^a-z0-9]/g,'')}.com — Available</span>
                                </div>
                              );
                              if (avail === 'taken') return (
                                <div className="mb-4">
                                  <div className="flex items-center gap-1.5 mb-2">
                                    <span className="w-1.5 h-1.5 rounded-full bg-red-500 inline-block" />
                                    <span className="text-[9px] font-mono text-red-400 uppercase tracking-widest">{name.toLowerCase().replace(/[^a-z0-9]/g,'')}.com — Taken</span>
                                  </div>
                                  <div className="pl-3 flex flex-col gap-1">
                                    <a
                                      href={`https://www.afternic.com/domain/${name.toLowerCase().replace(/[^a-z0-9]/g,'')}.com`}
                                      target="_blank"
                                      rel="noopener noreferrer"
                                      className="text-[9px] font-mono text-zinc-400 hover:text-white uppercase tracking-widest underline underline-offset-2 transition-colors w-fit"
                                    >
                                      Buy on Afternic →
                                    </a>
                                    <a
                                      href={`https://sedo.com/search/details/?domain=${name.toLowerCase().replace(/[^a-z0-9]/g,'')}.com`}
                                      target="_blank"
                                      rel="noopener noreferrer"
                                      className="text-[9px] font-mono text-zinc-500 hover:text-zinc-300 uppercase tracking-widest underline underline-offset-2 transition-colors w-fit"
                                    >
                                      Search on Sedo →
                                    </a>
                                    {gridDomainVariants[name] ? (
                                      <div className="mt-1.5 pt-1.5 border-t border-zinc-800 flex items-center gap-2">
                                        <span className="text-[9px] font-mono text-[#CCFF00] uppercase tracking-widest">{gridDomainVariants[name]!.domain} — open</span>
                                        <a
                                          href={`https://www.namecheap.com/domains/registration/results/?domain=${gridDomainVariants[name]!.domain}`}
                                          target="_blank"
                                          rel="noopener noreferrer"
                                          className="text-[9px] font-mono text-[#CCFF00] hover:underline underline-offset-2"
                                        >
                                          Register →
                                        </a>
                                      </div>
                                    ) : (
                                      <p className="text-[8px] font-mono text-zinc-600 mt-0.5">Or use "Evolve" below to find available variants</p>
                                    )}
                                  </div>
                                </div>
                              );
                              return null;
                            })()}
                            <div className="space-y-2.5 mb-5">
                              {metrics.map(({ label, value }) => (
                                <div key={label}>
                                  <div className="flex justify-between text-[9px] font-mono text-zinc-500 uppercase mb-1">
                                    <span>{label}</span><span className={value >= 80 ? 'text-[#CCFF00]' : value >= 60 ? 'text-zinc-300' : 'text-zinc-500'}>{value}</span>
                                  </div>
                                  <div className="w-full bg-zinc-900 h-[3px]">
                                    <div className={`h-[3px] score-bar ${value >= 80 ? 'bg-[#CCFF00]' : value >= 60 ? 'bg-zinc-400' : 'bg-zinc-600'}`} style={{ width: `${value}%` }} />
                                  </div>
                                </div>
                              ))}
                            </div>
                            <div className="flex gap-2 flex-wrap">
                              <button
                                onClick={() => toggleFavorite(name)}
                                title={favorites.includes(name) ? 'Remove from shortlist' : 'Add to shortlist'}
                                className={`flex items-center gap-1 text-[9px] font-mono uppercase tracking-widest border px-2 py-1 active:scale-95 transition-all ${favorites.includes(name) ? 'border-[#CCFF00]/50 text-[#CCFF00] bg-[#CCFF00]/10' : 'border-zinc-800 text-zinc-500 hover:text-[#CCFF00] hover:border-[#CCFF00]/30'}`}
                              >
                                <Star className={`w-3 h-3 ${favorites.includes(name) ? 'fill-[#CCFF00]' : ''}`} />
                              </button>
                              <button
                                onClick={() => speakName(name)}
                                title="Hear pronunciation"
                                className="flex items-center gap-1 text-[9px] font-mono uppercase tracking-widest text-zinc-500 hover:text-white active:scale-95 border border-zinc-800 hover:border-zinc-600 px-2 py-1 transition-all"
                              >
                                <Volume2 className="w-3 h-3" /> Speak
                              </button>
                              <button
                                onClick={() => handleEvolve(name)}
                                disabled={evolveLoading}
                                className="flex items-center gap-1 text-[9px] font-mono uppercase tracking-widest text-zinc-500 hover:text-[#CCFF00] active:scale-95 border border-zinc-800 hover:border-[#CCFF00]/40 px-2 py-1 transition-all disabled:opacity-40 disabled:active:scale-100"
                              >
                                {evolveLoading && evolveTarget === name ? <Loader2 className="w-3 h-3 animate-spin" /> : <Sparkles className="w-3 h-3" />} Evolve
                              </button>
                              <button
                                onClick={() => handleBrandStory(name)}
                                disabled={brandStoryLoading}
                                className="flex items-center gap-1 text-[9px] font-mono uppercase tracking-widest text-zinc-500 hover:text-zinc-200 active:scale-95 border border-zinc-800 hover:border-zinc-600 px-2 py-1 transition-all disabled:opacity-40 disabled:active:scale-100"
                              >
                                {brandStoryLoading && brandStoryTarget === name ? <Loader2 className="w-3 h-3 animate-spin" /> : <BookOpen className="w-3 h-3" />} Story
                              </button>
                              <button
                                onClick={() => {
                                  setSelectedName(name);
                                  setDomainStatus('idle');
                                  toast.success(`"${name}" selected.`, { id: 'name-selected', style: { background: '#050505', color: '#CCFF00', border: '1px solid #CCFF00' } });
                                  setTimeout(() => document.getElementById('secure-asset-section')?.scrollIntoView({ behavior: 'smooth' }), 100);
                                }}
                                className={`flex-1 text-[9px] font-mono uppercase tracking-widest px-2 py-1 transition-colors border ${isSelected ? 'bg-[#CCFF00] text-black border-[#CCFF00]' : 'text-zinc-400 border-zinc-800 hover:border-[#CCFF00]/50 hover:text-[#CCFF00]'}`}
                              >
                                {isSelected ? '✓ Selected' : 'Acquire'}
                              </button>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>

              {/* Alternative Names - Auto-generated when 2+ names are taken */}
              <AnimatePresence>
                {(generatingAlternatives || alternativeNames.length > 0) && (
                  <motion.div
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -10 }}
                    className="border border-[#CCFF00]/30 bg-[#050505]/80 backdrop-blur-sm p-5 lg:p-6"
                  >
                    <div className="flex items-center gap-2 mb-4">
                      <Sparkles className="w-3 h-3 text-[#CCFF00]" />
                      <p className="text-[10px] font-mono text-[#CCFF00] uppercase tracking-[0.2em]">
                        {generatingAlternatives
                          ? 'Searching For Available Names...'
                          : alternativesExhausted
                          ? 'No Available Alternatives Found'
                          : 'Alternative Available Names'}
                      </p>
                    </div>
                    {(() => {
                      // Never surface a confirmed-taken name here — this section's only
                      // job is names the user can actually register. "Checking" and
                      // "unknown" stay visible (still resolving / RDAP was inconclusive);
                      // "taken" is dropped from the grid entirely, not badged.
                      const visibleNames = alternativeNames.filter(n => alternativeAvailability[n] !== 'taken');
                      const availableCount = alternativeNames.filter(n => alternativeAvailability[n] === 'available').length;

                      if (generatingAlternatives && visibleNames.length === 0) {
                        return (
                          <div className="flex items-center gap-2 text-zinc-400 font-mono text-xs">
                            <Loader2 className="w-3 h-3 animate-spin" />
                            Finding available alternatives...
                          </div>
                        );
                      }

                      if (!generatingAlternatives && alternativesExhausted && availableCount === 0) {
                        const takenPrimaryNames = Object.entries(domainAvailability)
                          .filter(([, v]) => v === 'taken')
                          .map(([n]) => n);
                        const bestTaken = takenPrimaryNames[0];
                        return (
                          <div className="text-xs font-mono text-zinc-400">
                            <p className="mb-3">No clean .com matches found in this naming space after several rounds of search. Your strongest option is still the original name — the .com is just taken, not the name:</p>
                            {bestTaken && (
                              <div className="pl-3 flex flex-col gap-1">
                                <a
                                  href={`https://www.afternic.com/domain/${bestTaken.toLowerCase().replace(/[^a-z0-9]/g,'')}.com`}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="text-[9px] font-mono text-[#CCFF00] hover:text-white uppercase tracking-widest underline underline-offset-2 transition-colors w-fit"
                                >
                                  Buy {bestTaken.toLowerCase().replace(/[^a-z0-9]/g,'')}.com on Afternic →
                                </a>
                                <a
                                  href={`https://sedo.com/search/details/?domain=${bestTaken.toLowerCase().replace(/[^a-z0-9]/g,'')}.com`}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="text-[9px] font-mono text-zinc-500 hover:text-zinc-300 uppercase tracking-widest underline underline-offset-2 transition-colors w-fit"
                                >
                                  Search {bestTaken.toLowerCase().replace(/[^a-z0-9]/g,'')}.com on Sedo →
                                </a>
                                <p className="text-[8px] font-mono text-zinc-600 mt-1">Or check the Alternative TLDs on the winning name below (.ai, .io, .co).</p>
                              </div>
                            )}
                          </div>
                        );
                      }

                      return (
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                          {visibleNames.map((name, i) => {
                            const avail = alternativeAvailability[name];
                            return (
                              <div key={i} className={`border p-4 transition-all duration-200 ${avail === 'available' ? 'border-[#CCFF00]/50 bg-[#CCFF00]/5' : 'border-zinc-800 hover:border-zinc-600'}`}>
                                <div className="flex items-center justify-between mb-2">
                                  <span className="font-display font-bold text-lg text-white">{name}</span>
                                  {avail === 'checking' && (
                                    <span className="w-1.5 h-1.5 rounded-full bg-zinc-500 animate-pulse" />
                                  )}
                                  {avail === 'available' && (
                                    <span className="text-[9px] font-mono text-[#CCFF00] uppercase tracking-widest">Available</span>
                                  )}
                                  {avail === 'unknown' && (
                                    <span className="text-[9px] font-mono text-zinc-500 uppercase tracking-widest">Unverified</span>
                                  )}
                                </div>
                                {avail === 'available' && (
                                  <a
                                    href={`https://www.namecheap.com/domains/registration/results/?domain=${name.toLowerCase().replace(/[^a-z0-9]/g,'')}.com`}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="text-[9px] font-mono text-[#CCFF00] hover:text-white uppercase tracking-widest underline underline-offset-2 transition-colors"
                                  >
                                    Register {name.toLowerCase().replace(/[^a-z0-9]/g,'')}.com →
                                  </a>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      );
                    })()}
                  </motion.div>
                )}
              </AnimatePresence>

              {/* Brand Story Panel */}
              <AnimatePresence>
                {brandStoryTarget && (brandStoryLoading || brandStoryText) && (
                  <motion.div
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -10 }}
                    className="border border-zinc-700/60 bg-[#050505]/80 backdrop-blur-sm p-5 lg:p-6"
                  >
                    <div className="flex items-center justify-between mb-5">
                      <div className="flex items-center gap-2">
                        <BookOpen className="w-3 h-3 text-[#CCFF00]" />
                        <p className="text-[10px] font-mono text-[#CCFF00] uppercase tracking-[0.2em]">
                          Brand Story: <span className="text-white">{brandStoryTarget}</span>
                        </p>
                      </div>
                      <button onClick={() => { setBrandStoryTarget(null); setBrandStoryText(''); }} className="text-[9px] font-mono text-zinc-600 hover:text-white uppercase tracking-widest">
                        [ Close ]
                      </button>
                    </div>
                    {brandStoryLoading && !brandStoryText && (
                      <div className="flex items-center gap-2 text-zinc-500 font-mono text-xs">
                        <Loader2 className="w-3 h-3 animate-spin" /> Drafting brand narrative…
                      </div>
                    )}
                    <div className="markdown-body text-sm">
                      <Markdown>{brandStoryText}</Markdown>
                      {brandStoryLoading && <span className="animate-pulse text-[#CCFF00]">_</span>}
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>

              {/* Evolve Panel */}
              <AnimatePresence>
                {evolveTarget && (evolveLoading || evolveResponse) && (
                  <motion.div
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -10 }}
                    className="border border-zinc-700/60 bg-[#050505]/80 backdrop-blur-sm p-5 lg:p-6"
                  >
                    <div className="flex items-center justify-between mb-5">
                      <div className="flex items-center gap-2">
                        <Sparkles className="w-3 h-3 text-[#CCFF00]" />
                        <p className="text-[10px] font-mono text-[#CCFF00] uppercase tracking-[0.2em]">
                          Evolution: <span className="text-white">{evolveTarget}</span>
                        </p>
                      </div>
                      <button onClick={() => { setEvolveTarget(null); setEvolveResponse(''); setParsedEvolvedNames([]); }} className="text-[9px] font-mono text-zinc-600 hover:text-white uppercase tracking-widest">
                        [ Close ]
                      </button>
                    </div>
                    {evolveLoading && !evolveResponse && (
                      <div className="flex items-center gap-2 text-zinc-500 font-mono text-xs">
                        <Loader2 className="w-3 h-3 animate-spin" /> Engineering variants...
                      </div>
                    )}
                    <div className="markdown-body text-sm">
                      <Markdown>{evolveResponse}</Markdown>
                      {evolveLoading && <span className="animate-pulse text-[#CCFF00]">_</span>}
                    </div>
                    {parsedEvolvedNames.length > 0 && (
                      <div className="mt-5 pt-4 border-t border-zinc-900">
                        <p className="text-[9px] font-mono text-zinc-500 uppercase tracking-widest mb-3">Quick-select a variant:</p>
                        <div className="flex flex-wrap gap-2">
                          {parsedEvolvedNames.map((n, i) => (
                            <button
                              key={i}
                              onClick={() => {
                                setSelectedName(n);
                                setDomainStatus('idle');
                                toast.success(`"${n}" selected.`, { id: 'name-selected', style: { background: '#050505', color: '#CCFF00', border: '1px solid #CCFF00' } });
                                setTimeout(() => document.getElementById('secure-asset-section')?.scrollIntoView({ behavior: 'smooth' }), 100);
                              }}
                              className="font-display font-bold py-2 px-4 border border-zinc-700 hover:border-[#CCFF00] text-white hover:text-[#CCFF00] transition-all text-sm"
                            >{n}</button>
                          ))}
                        </div>
                      </div>
                    )}
                  </motion.div>
                )}
              </AnimatePresence>

              {/* Domain lookup — real RDAP check, no fabricated pricing/brokerage */}
              <AnimatePresence>
                {!loading && response && (
                  <motion.div
                    id="secure-asset-section"
                    initial={{ opacity: 0, y: 20 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -20 }}
                    className="border border-[#CCFF00]/30 bg-[#CCFF00]/[0.02] p-6 lg:p-10 relative overflow-hidden"
                  >
                    <div className="absolute top-0 left-0 w-1 h-full bg-[#CCFF00]"></div>
                    <div className="absolute top-0 right-0 w-32 h-32 bg-[#CCFF00]/5 blur-3xl rounded-full pointer-events-none"></div>

                    <h2 className="text-3xl font-display font-bold text-white mb-3 tracking-tight flex items-center gap-3">
                      <Sparkles className="w-6 h-6 text-[#CCFF00]" />
                      Check a Name
                    </h2>
                    <p className="text-zinc-300 font-normal mb-8 max-w-2xl">Look up real-time .com availability for the winning name via the domain registry (RDAP) — the same check used during screening.</p>

                    <div className="space-y-8 relative z-10">
                      <div className="flex flex-col sm:flex-row gap-4">
                        <input
                          type="text"
                          value={selectedName}
                          onChange={(e) => {
                            setSelectedName(e.target.value);
                            setDomainStatus('idle');
                          }}
                          placeholder="Enter the winning name..."
                          className="flex-1 bg-zinc-900 border border-zinc-600 p-5 text-xl text-white focus:outline-none focus:border-[#CCFF00] transition-all font-display placeholder:text-zinc-500 shadow-inner"
                        />
                        <button
                          onClick={checkDomain}
                          disabled={!selectedName || domainStatus === 'checking'}
                          className="bg-zinc-900 hover:bg-zinc-800 border border-zinc-800 text-white font-mono text-sm uppercase tracking-widest py-5 px-8 transition-colors flex items-center justify-center gap-3 disabled:opacity-50"
                        >
                          {domainStatus === 'checking' ? <Loader2 className="w-5 h-5 animate-spin" /> : 'Check Availability'}
                        </button>
                        <button
                          onClick={checkTrademark}
                          disabled={!selectedName || trademarkStatus === 'checking'}
                          className="bg-zinc-900 hover:bg-zinc-800 border border-zinc-800 text-white font-mono text-sm uppercase tracking-widest py-5 px-8 transition-colors flex items-center justify-center gap-3 disabled:opacity-50"
                        >
                          {trademarkStatus === 'checking' ? <Loader2 className="w-5 h-5 animate-spin" /> : 'Screen Trademark'}
                        </button>
                      </div>

                      {trademarkStatus !== 'idle' && (
                        <div className="bg-zinc-900/40 border border-zinc-700/50 p-8">
                          {trademarkStatus === 'checking' ? (
                            <div className="flex items-center gap-3 text-zinc-400 font-mono text-sm">
                              <Loader2 className="w-5 h-5 animate-spin" /> Screening live USPTO records...
                            </div>
                          ) : trademarkStatus === 'unavailable' ? (
                            <div className="flex items-start gap-4">
                              <ShieldCheck className="w-8 h-8 text-zinc-500 shrink-0" />
                              <div>
                                <h3 className="text-xl font-display font-bold text-zinc-300 mb-1">Trademark screening unavailable</h3>
                                <p className="text-zinc-400 font-mono text-sm">{trademarkError}</p>
                              </div>
                            </div>
                          ) : (
                            <div className="flex items-start gap-4">
                              <ShieldCheck className={`w-8 h-8 shrink-0 ${trademarkStatus === 'clear' ? 'text-[#CCFF00]' : trademarkStatus === 'caution' ? 'text-yellow-500' : 'text-red-500'}`} />
                              <div className="flex-1">
                                <h3 className="text-xl font-display font-bold text-white mb-1">
                                  {trademarkStatus === 'clear' && 'No live conflicts found'}
                                  {trademarkStatus === 'caution' && 'Similar live marks found'}
                                  {trademarkStatus === 'conflict' && 'Exact live mark found'}
                                </h3>
                                {trademarkMatches.length > 0 && (
                                  <ul className="mt-3 mb-4 space-y-1">
                                    {trademarkMatches.map((m, i) => (
                                      <li key={i} className="text-sm font-mono text-zinc-300">
                                        <span className="text-white">{m.mark}</span> — {m.status}
                                        {m.serialNumber ? ` (Serial #${m.serialNumber})` : ''}
                                      </li>
                                    ))}
                                  </ul>
                                )}
                              </div>
                            </div>
                          )}
                          {trademarkDisclaimer && (
                            <p className="text-[11px] font-mono text-zinc-500 mt-4 pt-4 border-t border-zinc-800 leading-relaxed">
                              ⚠ {trademarkDisclaimer}
                            </p>
                          )}
                        </div>
                      )}

                      <AnimatePresence>
                        {(domainStatus === 'available' || domainStatus === 'taken' || domainStatus === 'unknown') && (
                          <motion.div
                            initial={{ opacity: 0, height: 0 }}
                            animate={{ opacity: 1, height: 'auto' }}
                            exit={{ opacity: 0, height: 0 }}
                            className="bg-zinc-900/40 border border-zinc-700/50 p-8 overflow-hidden"
                          >
                            {(() => {
                              const clean = selectedName.toLowerCase().replace(/[^a-z0-9]/g, '');
                              if (domainStatus === 'available') return (
                                <div className="flex items-start gap-4">
                                  <CheckCircle className="w-8 h-8 text-[#CCFF00] shrink-0" />
                                  <div>
                                    <h3 className="text-xl font-display font-bold text-[#CCFF00] mb-1">{clean}.com is available</h3>
                                    <p className="text-zinc-300 font-mono text-sm mb-4">Unregistered — you can claim it directly at any registrar. NamingStorm doesn't broker or process domain purchases.</p>
                                    <a href={`https://www.namecheap.com/domains/registration/results/?domain=${clean}.com`} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-2 text-sm text-[#CCFF00] hover:underline font-mono">
                                      Register on Namecheap <ChevronRight className="w-4 h-4" />
                                    </a>
                                  </div>
                                </div>
                              );
                              if (domainStatus === 'taken') return (
                                <div className="flex items-start gap-4">
                                  <Globe className="w-8 h-8 text-zinc-400 shrink-0" />
                                  <div>
                                    <h3 className="text-xl font-display font-bold text-white mb-1">{clean}.com is taken</h3>
                                    <p className="text-zinc-300 font-mono text-sm mb-4">Already registered. If you want it, check the real aftermarket listing — we don't appraise or negotiate this ourselves.</p>
                                    <div className="flex flex-wrap gap-4 mb-4">
                                      <a href={`https://www.afternic.com/domain/${clean}.com`} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-2 text-sm text-[#CCFF00] hover:underline font-mono">
                                        Buy on Afternic <ChevronRight className="w-4 h-4" />
                                      </a>
                                      <a href={`https://sedo.com/search/details/?domain=${clean}.com`} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-2 text-sm text-[#CCFF00] hover:underline font-mono">
                                        Search on Sedo <ChevronRight className="w-4 h-4" />
                                      </a>
                                    </div>
                                    {domainVariant && (
                                      <div className="border-t border-zinc-800 pt-4">
                                        <p className="text-[10px] font-mono text-zinc-500 uppercase tracking-widest mb-2">Brandable Alternative Available</p>
                                        <div className="flex items-center gap-3">
                                          <span className="text-lg font-display font-bold text-[#CCFF00]">{domainVariant.domain}</span>
                                          <a href={`https://www.namecheap.com/domains/registration/results/?domain=${domainVariant.domain}`} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-xs text-[#CCFF00] hover:underline font-mono">
                                            Register <ChevronRight className="w-3 h-3" />
                                          </a>
                                        </div>
                                      </div>
                                    )}
                                  </div>
                                </div>
                              );
                              return (
                                <div className="flex items-start gap-4">
                                  <Globe className="w-8 h-8 text-zinc-500 shrink-0" />
                                  <div>
                                    <h3 className="text-xl font-display font-bold text-zinc-300 mb-1">Couldn't confirm {clean}.com</h3>
                                    <p className="text-zinc-400 font-mono text-sm">The domain registry didn't respond in time. Try again in a moment.</p>
                                  </div>
                                </div>
                              );
                            })()}
                          </motion.div>
                        )}
                      </AnimatePresence>
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>

          </div>
        </div>
      </div>

      {/* Paywall Modal */}
      <AnimatePresence>
        {showPaywall && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/95 backdrop-blur-sm"
          >
            <motion.div
              initial={{ opacity: 0, y: 24 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 24 }}
              transition={{ duration: 0.3 }}
              className="w-full max-w-2xl"
            >
              {/* Header */}
              <div className="text-center mb-8">
                <p className="text-[9px] font-mono text-zinc-500 uppercase tracking-[0.3em] mb-3">Protocol Access Required</p>
                <h2 className="text-3xl md:text-4xl font-display font-bold text-white tracking-tight mb-4">
                  You've used your {FREE_SEARCH_LIMIT} free searches.
                </h2>
                <p className="text-sm font-mono text-zinc-400 max-w-md mx-auto">
                  A naming agency charges <span className="text-zinc-200">$5,000–$50,000</span> and takes 6 weeks.<br />
                  Create a free account to keep going.
                </p>
              </div>

              {/* Pricing cards */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
                {/* Search Pack */}
                <div className="border border-zinc-800 bg-zinc-950 p-6">
                  <p className="text-[9px] font-mono text-zinc-500 uppercase tracking-widest mb-2">Pay As You Go</p>
                  <div className="flex items-baseline gap-1 mb-1">
                    <span className="text-4xl font-display font-bold text-white">$5</span>
                    <span className="text-sm font-mono text-zinc-500">/ {PAID_SEARCH_PACK_SIZE} searches</span>
                  </div>
                  <p className="text-xs font-mono text-zinc-600 mb-5">{PAID_SEARCH_PACK_SIZE} name-generation searches. No subscription.</p>
                  <ul className="space-y-2 mb-6">
                    {['3 engineered brand names per search', 'Phonetic + trademark scoring', 'Real .com availability check', 'Brand story generator', 'PDF export'].map(f => (
                      <li key={f} className="flex items-center gap-2 text-[11px] font-mono text-zinc-400">
                        <span className="text-zinc-600">—</span> {f}
                      </li>
                    ))}
                  </ul>
                  <button
                    onClick={() => handleCheckout('report')}
                    disabled={paywallLoading !== null}
                    className="w-full border border-zinc-700 hover:border-zinc-400 text-zinc-300 hover:text-white font-mono text-[11px] uppercase tracking-widest py-3 transition-colors disabled:opacity-40 flex items-center justify-center gap-2"
                  >
                    {paywallLoading === 'report' ? <><Loader2 className="w-3 h-3 animate-spin" /> Redirecting…</> : `Buy ${PAID_SEARCH_PACK_SIZE} Searches →`}
                  </button>
                </div>

                {/* Pro Monthly */}
                <div className="border border-[#CCFF00]/40 bg-zinc-950 p-6 relative">
                  <div className="absolute -top-3 left-1/2 -translate-x-1/2 bg-[#CCFF00] text-black text-[9px] font-mono font-bold uppercase tracking-widest px-3 py-1">
                    Most Popular
                  </div>
                  <p className="text-[9px] font-mono text-[#CCFF00]/60 uppercase tracking-widest mb-2">Unlimited Access</p>
                  <div className="flex items-baseline gap-1 mb-1">
                    <span className="text-4xl font-display font-bold text-[#CCFF00]">$12</span>
                    <span className="text-sm font-mono text-zinc-500">/ month</span>
                  </div>
                  <p className="text-xs font-mono text-zinc-600 mb-5">Pays for itself after 2 reports.</p>
                  <ul className="space-y-2 mb-6">
                    {['Everything in single report', 'Unlimited reports / month', 'Unlimited Evolve variants', 'Unlimited brand stories', 'Priority generation'].map(f => (
                      <li key={f} className="flex items-center gap-2 text-[11px] font-mono text-zinc-400">
                        <span className="text-[#CCFF00]/60">—</span> {f}
                      </li>
                    ))}
                  </ul>
                  <button
                    onClick={() => handleCheckout('pro')}
                    disabled={paywallLoading !== null}
                    className="w-full bg-[#CCFF00] hover:bg-[#E6FF00] text-black font-mono font-bold text-[11px] uppercase tracking-widest py-3 transition-colors disabled:opacity-40 flex items-center justify-center gap-2"
                  >
                    {paywallLoading === 'pro' ? <><Loader2 className="w-3 h-3 animate-spin" /> Redirecting…</> : 'Start Pro — $12 / month →'}
                  </button>
                </div>
              </div>

              {/* Create Account Option */}
              <div className="text-center mt-4">
                <p className="text-[10px] font-mono text-zinc-500 mb-2">Don't have an account?</p>
                <button
                  onClick={handleShowCreateAccount}
                  className="text-[11px] font-mono text-[#CCFF00] hover:text-[#E6FF00] uppercase tracking-widest transition-colors"
                >
                  Create Free Account →
                </button>
              </div>

              {/* Footer */}
              <div className="text-center mt-4">
                <p className="text-[9px] font-mono text-zinc-700 mb-3">Payments processed securely by Stripe. Cancel anytime.</p>
                <button
                  onClick={() => setShowPaywall(false)}
                  className="text-[10px] font-mono text-zinc-700 hover:text-zinc-500 uppercase tracking-widest transition-colors"
                >
                  ← Back to report
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Account Creation Modal */}
      <AnimatePresence>
        {showPhonePrompt && (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 20 }}
            className="fixed bottom-5 left-5 right-5 sm:left-auto sm:right-24 z-40 max-w-sm border border-zinc-800 bg-[#050505] p-4 shadow-2xl"
          >
            <div className="flex items-start justify-between gap-3 mb-2">
              <p className="text-sm font-mono text-white">Want a text when your next report's ready?</p>
              <button onClick={handleSkipPhonePrompt} aria-label="Dismiss" className="text-zinc-500 hover:text-white shrink-0 p-4 -m-4">
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="flex gap-2">
              <input
                type="tel"
                value={phoneInput}
                onChange={(e) => setPhoneInput(e.target.value)}
                placeholder="+1 555 123 4567"
                className="flex-1 min-w-0 bg-zinc-950 border border-zinc-800 focus:border-[#CCFF00] text-sm font-mono text-white px-3 py-2 outline-none placeholder:text-zinc-600"
              />
              <button
                onClick={handleSavePhone}
                disabled={savingPhone}
                className="bg-[#CCFF00] hover:bg-[#E6FF00] disabled:opacity-50 text-black font-mono font-bold text-[10px] uppercase tracking-widest px-4 transition-colors"
              >
                {savingPhone ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Save'}
              </button>
            </div>
            <button onClick={handleSkipPhonePrompt} className="text-[10px] font-mono text-zinc-600 hover:text-zinc-400 uppercase tracking-widest mt-2">
              Skip
            </button>
          </motion.div>
        )}

        {showAccountModal && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/95 backdrop-blur-sm"
          >
            <motion.div
              initial={{ opacity: 0, y: 24 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 24 }}
              transition={{ duration: 0.3 }}
              className="w-full max-w-md"
            >
              <div className="text-center mb-8">
                <p className="text-[9px] font-mono text-zinc-500 uppercase tracking-[0.3em] mb-3">Create Account</p>
                <h2 className="text-2xl md:text-3xl font-display font-bold text-white tracking-tight mb-4">
                  Join NamingStorm
                </h2>
                <p className="text-sm font-mono text-zinc-400 max-w-sm mx-auto">
                  Create a free account to save your reports, track favorites, and manage subscriptions.
                </p>
              </div>

              <div className="border border-zinc-800 bg-zinc-950 p-6 mb-4">
                <button
                  onClick={handleLoginWithGoogle}
                  className="w-full bg-[#CCFF00] hover:bg-[#E6FF00] text-black font-mono font-bold text-[11px] uppercase tracking-widest py-4 transition-colors flex items-center justify-center gap-3 mb-4"
                >
                  <svg className="w-5 h-5" viewBox="0 0 24 24">
                    <path fill="currentColor" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
                    <path fill="currentColor" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
                    <path fill="currentColor" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
                    <path fill="currentColor" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
                  </svg>
                  Continue with Google
                </button>

                <div className="flex items-center gap-3 mb-4">
                  <div className="flex-1 h-px bg-zinc-800"></div>
                  <span className="text-[9px] font-mono text-zinc-600 uppercase">or</span>
                  <div className="flex-1 h-px bg-zinc-800"></div>
                </div>

                <button
                  onClick={() => { setShowAccountModal(false); handleLoginAsGuest(); }}
                  className="w-full border border-zinc-700 hover:border-zinc-400 text-zinc-300 hover:text-white font-mono text-[11px] uppercase tracking-widest py-3 transition-colors"
                >
                  Continue as Guest
                </button>
              </div>

              <div className="text-center">
                <button
                  onClick={() => setShowAccountModal(false)}
                  className="text-[10px] font-mono text-zinc-700 hover:text-zinc-500 uppercase tracking-widest transition-colors"
                >
                  ← Go back
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      <FeedbackWidget />
    </div>
    </MotionConfig>
  );
}
