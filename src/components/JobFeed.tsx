'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { Database, Briefcase, MapPin, Building, ChevronRight, Check, CheckCircle2, Link as LinkIcon, Linkedin, FileText, ArrowRight, ShieldCheck, TrendingUp, ThumbsDown } from 'lucide-react';
import { getJobs, Job, markJobAsApplied } from '../app/actions/jobActions';
import { reportJobAction } from '../app/actions/reportActions';
import { getSubscriptionStatus } from '../app/actions/subscriptionActions';

interface JobFeedProps {
    initialJobs: Job[];
    initialTotalPages: number;
    initialAppliedJobs?: Record<string, string>;
    isGuest?: boolean;
    searchParams: {
        q?: string;
        loc?: string;
        tier2?: string;
        locs?: string | string[];
        userPrefs?: any;
        type?: string;
    };
}

// Fix known bad URL patterns (SmartRecruiters API URL -> public page)
function fixJobUrl(url: string): string {
    if (!url) return '#';
    if (url.includes('api.smartrecruiters.com')) {
        const match = url.match(/\/companies\/([^/]+)\/postings\/([^/?#]+)/);
        if (match) return `https://jobs.smartrecruiters.com/${match[1]}/${match[2]}`;
    }
    return url;
}

export default function JobFeed({ initialJobs, initialTotalPages, initialAppliedJobs = {}, isGuest = false, searchParams }: JobFeedProps) {
    const GUEST_LIMIT = 2;
    const displayedInitialJobs = isGuest ? initialJobs.slice(0, GUEST_LIMIT) : initialJobs;

    const [jobs, setJobs] = useState<Job[]>(displayedInitialJobs);
    const [isPro, setIsPro] = useState(true); // Default to true while loading to avoid flash
    const [page, setPage] = useState(1);
    const [isFetching, setIsFetching] = useState(false);
    const [isMobileDetailsOpen, setIsMobileDetailsOpen] = useState(false);
    const [sort, setSort] = useState('newest');

    const [selectedJobId, setSelectedJobId] = useState<string | null>(displayedInitialJobs.length > 0 ? displayedInitialJobs[0].id : null);

    // Track seen IDs to avoid duplicates and ensure diversity across "Load More"
    const [seenJobIds, setSeenJobIds] = useState<string[]>(displayedInitialJobs.map(j => j.id));
    const [seenCompanyIds, setSeenCompanyIds] = useState<number[]>(displayedInitialJobs.map(j => j.company_id));
    const [reportedJobIds, setReportedJobIds] = useState<Set<string>>(new Set());
    const [dismissingJobIds, setDismissingJobIds] = useState<Set<string>>(new Set());
    const [hiddenJobIds, setHiddenJobIds] = useState<Set<string>>(new Set());
    // appliedJobIds: map of jobId -> applied timestamp (or true)
    const [appliedJobIds, setAppliedJobIds] = useState<Map<string, string>>(() => {
        const m = new Map<string, string>();
        Object.entries(initialAppliedJobs).forEach(([id, ts]) => m.set(id, ts));
        return m;
    });

    useEffect(() => {
        getSubscriptionStatus().then(res => setIsPro(res.isPro));
    }, []);

    const totalPages = initialTotalPages;

    useEffect(() => {
        if (!selectedJobId && jobs.length > 0) {
            setSelectedJobId(jobs[0].id);
        }
    }, [jobs, selectedJobId]);

    const selectedJob = jobs.find(j => j.id === selectedJobId);

    const handleJobClick = (jobId: string) => {
        setSelectedJobId(jobId);
        setIsMobileDetailsOpen(true);
    };

    const loadMore = async () => {
        setIsFetching(true);
        // Artificial 1-second delay for UX as requested
        await new Promise(resolve => setTimeout(resolve, 1000));

        try {
            const nextPage = page + 1;
            const data = await getJobs({
                ...searchParams,
                sort,
                page: nextPage,
                excludedJobIds: seenJobIds,
                excludedCompanyIds: seenCompanyIds
            });

            if (data && data.jobs) {
                const newJobs = data.jobs as Job[];
                setJobs(prev => [...prev, ...newJobs]);
                setSeenJobIds(prev => [...prev, ...newJobs.map(j => j.id)]);
                setSeenCompanyIds(prev => [...prev, ...newJobs.map(j => j.company_id)]);
                setPage(nextPage);
            }
        } catch (error) {
            console.error('Error fetching more jobs:', error);
        } finally {
            setIsFetching(false);
        }
    };

    const handleSortChange = async (newSort: string) => {
        setSort(newSort);
        setIsFetching(true);
        try {
            const data = await getJobs({
                ...searchParams,
                sort: newSort,
                page: 1
            });
            if (data && data.jobs) {
                const fetchedJobs = data.jobs as Job[];
                setJobs(fetchedJobs);
                setPage(1);
                setSeenJobIds(fetchedJobs.map(j => j.id));
                setSeenCompanyIds(fetchedJobs.map(j => j.company_id));
                if (fetchedJobs.length > 0) {
                    setSelectedJobId(fetchedJobs[0].id);
                }
            }
        } catch (error) {
            console.error('Error changing sort:', error);
        } finally {
            setIsFetching(false);
        }
    };

    const handleApplyClick = async (e: React.MouseEvent, jobId: string) => {
        e.stopPropagation(); // prevent card selection
        if (appliedJobIds.has(jobId)) return;

        const appliedAt = new Date().toISOString();
        setAppliedJobIds(prev => {
            const newMap = new Map(prev);
            newMap.set(jobId, appliedAt);
            return newMap;
        });

        const res = await markJobAsApplied(jobId);
        if (!res.success) {
            // Revert on failure
            setAppliedJobIds(prev => {
                const newMap = new Map(prev);
                newMap.delete(jobId);
                return newMap;
            });
            alert(res.error || 'Failed to mark as applied');
        }
    };

    const handleReportClick = async (e: React.MouseEvent, jobId: string) => {
        e.stopPropagation();
        if (reportedJobIds.has(jobId)) return;

        const reason = window.prompt("Why are you reporting this job? (e.g., Expired, Wrong location, etc.)\n\nYour feedback helps us keep GetLanded accurate for everyone! 🙏");

        // If user cancels or gives empty reason, we can still report or skip. 
        // Let's require a reason or just proceed if they hit OK with empty.
        if (reason === null) return; // User cancelled

        setReportedJobIds(prev => new Set(prev).add(jobId));

        const res = await reportJobAction(Number(jobId), reason.trim() || undefined);
        if (!res.success) {
            setReportedJobIds(prev => {
                const newSet = new Set(prev);
                newSet.delete(jobId);
                return newSet;
            });
            alert(res.error || 'Failed to report job');
        }
    };

    const handleDismissClick = (e: React.MouseEvent, jobId: string) => {
        e.stopPropagation();
        if (dismissingJobIds.has(jobId)) return;

        setDismissingJobIds(prev => new Set(prev).add(jobId));

        setTimeout(() => {
            setHiddenJobIds(prev => new Set(prev).add(jobId));
        }, 1500);
    };

    if (jobs.length === 0) {
        return (
            <div className="text-center py-12 sm:py-20 bg-[var(--card)] rounded-none border border-dashed border-[var(--border)] px-6 relative z-10 w-full lg:w-[55%]">
                <Database className="w-10 h-10 text-slate-300 mx-auto mb-4" />
                <h3 className="text-lg font-medium text-slate-900 dark:text-white">No open roles</h3>
                <div className="text-slate-500 mt-1 max-w-xs mx-auto">
                    {isGuest ? (
                        <p>Try adjusting your search terms.</p>
                    ) : (
                        <p>
                            Try adjusting your filters or{' '}
                            <Link href="/account/preferences" className="text-[#0066FF] font-medium hover:underline">
                                update your preferences
                            </Link>
                            .
                        </p>
                    )}
                </div>
            </div>
        );
    }

    return (
        <div className="flex flex-col lg:flex-row gap-6 relative items-start lg:h-[calc(100vh-8rem)]">

            {/* Middle Column: Job List — scrolls independently */}
            <div className="w-full lg:w-[55%] lg:h-full lg:overflow-y-auto pb-32 sm:pb-8 pr-1 flex flex-col">

                {/* Mobile Header / Desktop Sort */}
                <div className="flex items-center justify-between sm:justify-end mb-4 shrink-0">
                    <div className="flex md:hidden text-[13px] font-bold text-slate-900">
                        Featured Opportunities
                    </div>
                    <div className="flex items-center gap-2 text-sm text-slate-500">
                        <span className="font-medium hidden sm:inline">Sort by:</span>
                        <div className="relative">
                            <select
                                value={sort}
                                onChange={(e) => handleSortChange(e.target.value)}
                                disabled={isFetching}
                                className="appearance-none bg-white border border-[var(--border)] text-slate-700 font-medium text-sm rounded-md pl-3 pr-8 py-1.5 focus:outline-none focus:border-[#0066FF] focus:ring-1 focus:ring-[#0066FF] cursor-pointer disabled:opacity-50 shadow-sm transition-colors"
                            >
                                <option value="newest">Newest first</option>
                                <option value="oldest">Oldest first</option>
                                <option value="title_asc">Title (A-Z)</option>
                                <option value="title_desc">Title (Z-A)</option>
                            </select>
                            <ChevronRight className="absolute right-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400 rotate-90 pointer-events-none" />
                        </div>
                    </div>
                </div>

                <div className="space-y-4">
                    {jobs.map((job) => {
                        if (hiddenJobIds.has(job.id)) return null;

                        const isSelected = selectedJobId === job.id;
                        const isNew = job.created_at
                            ? (Date.now() - new Date(job.created_at).getTime()) < 48 * 60 * 60 * 1000
                            : false;
                        return (
                            <div
                                key={job.id}
                                onClick={() => handleJobClick(job.id)}
                                className={`block bg-white border p-4 sm:p-5 rounded-md cursor-pointer transition-all ${isSelected ? 'border-brand-500 shadow-sm ring-1 ring-brand-500/10' : 'border-[var(--border)] hover:border-slate-300'}`}
                            >
                                <div className="flex items-center justify-between mb-3 border-b border-transparent">
                                    <div className="flex items-center gap-2">
                                        <div className="w-5 h-5 sm:w-6 sm:h-6 rounded-md border border-[var(--border)] overflow-hidden bg-white flex items-center justify-center shrink-0">
                                            {job.company?.url_favicon ? (
                                                <img src={job.company.url_favicon} alt="logo" className="w-3.5 h-3.5 sm:w-4 sm:h-4 object-contain" />
                                            ) : (
                                                <Building className="w-3.5 h-3.5 sm:w-4 sm:h-4 text-slate-400" />
                                            )}
                                        </div>
                                        <span className="font-semibold text-[12px] sm:text-sm text-slate-700 truncate max-w-[120px] sm:max-w-none">{job.company?.trading_name}</span>
                                    </div>
                                    <span className="text-[10px] sm:text-xs text-slate-400 font-medium">
                                        {job.created_at ? new Date(job.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : ''}
                                    </span>
                                </div>

                                <h3 className="font-bold text-[15px] sm:text-[17px] text-slate-900 mb-1.5 leading-snug">
                                    {isNew && <span className="bg-[#EFFFCC] text-[#4d5c0f] text-[9px] sm:text-[10px] font-bold px-1.5 py-0.5 rounded-[3px] mr-2 align-middle uppercase tracking-widest border border-[#d6f09e]">NEW</span>}
                                    {job.title}
                                </h3>

                                <div className="flex items-center gap-2 text-[12px] sm:text-[13px] text-slate-500 mb-4 font-medium">
                                    <span className="truncate">{job.department || 'General'}</span>
                                    <span>•</span>
                                    <span className="truncate">{job.location || 'UK'}</span>
                                </div>

                                <div className="flex items-center flex-wrap gap-2 mb-4">
                                    {job.level && (
                                        <span className="text-[10px] sm:text-[11px] font-semibold uppercase tracking-wide px-2 py-0.5 rounded-full bg-slate-100 text-slate-600 border border-slate-200">{job.level}</span>
                                    )}
                                    {job.company?.licensed_sponsor && (
                                        <div className="flex items-center gap-1.5 text-[10px] sm:text-[11px] text-[#0066FF] bg-[#0066FF]/5 px-2.5 py-1 rounded-none font-black uppercase tracking-wider border border-[#0066FF]/10 shadow-sm">
                                            <ShieldCheck className="w-3 h-3" /> Licensed
                                        </div>
                                    )}
                                </div>

                                <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between pt-3 border-t border-[var(--border)] mt-2 gap-3 sm:gap-0">
                                    {dismissingJobIds.has(job.id) ? (
                                        <div className="flex items-center gap-1.5 text-[12px] sm:text-[13px] text-emerald-600 font-medium">
                                            <Check className="w-4 h-4" /> We'll show you less like this
                                        </div>
                                    ) : (
                                        <button
                                            onClick={(e) => handleDismissClick(e, job.id)}
                                            className="text-[12px] sm:text-[13px] text-slate-500 hover:text-slate-800 font-medium transition-colors text-left flex items-center gap-1.5"
                                        >
                                            <ThumbsDown className="w-3.5 h-3.5" /> Show less like this
                                        </button>
                                    )}
                                    <div className="flex items-center gap-2">
                                        <button
                                            onClick={(e) => handleReportClick(e, job.id)}
                                            disabled={reportedJobIds.has(job.id)}
                                            className={`flex-1 sm:flex-none text-[12px] sm:text-[13px] font-medium px-3 py-1.5 rounded-sm transition-colors text-center ${reportedJobIds.has(job.id) ? 'bg-orange-50 text-orange-600 border border-orange-100 cursor-default' : 'text-slate-700 bg-slate-100 hover:bg-slate-200'}`}>
                                            {reportedJobIds.has(job.id) ? 'Reported' : 'Report Expired'}
                                        </button>
                                        <button
                                            onClick={(e) => handleApplyClick(e, job.id)}
                                            disabled={appliedJobIds.has(job.id) || isGuest}
                                            className={`flex-1 sm:flex-none text-[12px] sm:text-[13px] font-medium px-3 py-1.5 rounded-sm shadow-sm transition-colors flex items-center justify-center gap-1.5
                                            ${appliedJobIds.has(job.id)
                                                    ? 'bg-emerald-50 text-emerald-600 cursor-default shadow-none border border-emerald-100'
                                                    : isGuest ? 'bg-slate-50 text-slate-300 cursor-not-allowed border border-slate-100'
                                                        : 'text-white bg-[#0066FF] hover:bg-[#0052CC] active:scale-95'}`}
                                        >
                                            {appliedJobIds.has(job.id) ? (
                                                <><Check className="w-3.5 h-3.5" /> Applied</>
                                            ) : 'Mark applied'}
                                        </button>
                                    </div>
                                </div>
                            </div>
                        );
                    })}

                    {/* Guest CTA / Load More */}
                    {isGuest ? (
                        <div className="mt-4">
                            {/* CTA Card — same size & shape as a job card */}
                            <div className="bg-white border border-[var(--border)] rounded-md p-6 sm:p-8 shadow-sm">
                                <div className="flex flex-col items-center text-center py-2 sm:py-4">
                                    <p className="text-3xl sm:text-4xl font-extrabold text-[#137cdb] mb-1">20,000+</p>
                                    <h3 className="text-lg sm:text-xl font-bold text-slate-900 mb-2">UK jobs with visa sponsorship</h3>
                                    <p className="text-sm text-slate-500 mb-6 leading-relaxed max-w-xs">
                                        Every job here is at a verified UK visa sponsor. Filtered, updated, and ready for you.
                                    </p>
                                    <div className="flex flex-col sm:flex-row items-center gap-3 w-full max-w-xs">
                                        <a href="/signup" className="w-full sm:flex-1 bg-[#0066FF] hover:bg-[#0052CC] text-white font-black py-3 rounded-none text-[11px] sm:text-[12px] uppercase tracking-widest text-center transition-all active:scale-95 shadow-lg shadow-[#0066FF]/20">Get started free</a>
                                        <a href="/login" className="w-full sm:flex-1 border border-slate-200 text-slate-700 hover:bg-slate-50 font-black py-3 rounded-none text-[11px] sm:text-[12px] uppercase tracking-widest text-center transition-all active:scale-95">Sign in</a>
                                    </div>
                                </div>
                            </div>
                        </div>
                    ) : !isPro && jobs.length >= 5 ? (
                        <div className="mt-8 bg-white">
                            <div className="bg-white border-2 border-[#0066FF] rounded-none p-8 relative overflow-hidden group shadow-lg">
                                <div className="relative z-10 text-center sm:text-left">
                                    <div className="flex flex-col sm:flex-row items-center gap-4 mb-4">
                                        <div className="p-3 bg-blue-50 rounded-xl">
                                            <TrendingUp className="w-6 h-6 text-[#0066FF]" />
                                        </div>
                                        <h3 className="text-xl sm:text-2xl font-black text-black uppercase tracking-tight">Unlock 20,000+ More Jobs</h3>
                                    </div>
                                    <p className="text-slate-600 mb-8 max-w-md leading-relaxed text-sm sm:text-base">
                                        You've reached the limit of the Free Plan. Upgrade to Pro for just <span className="text-[#0066FF] font-black">£0.99/week</span> to see every visa-sponsored job in the UK.
                                    </p>
                                    <Link
                                        href="/account/subscription"
                                        className="inline-flex items-center justify-center gap-2 px-8 py-4 bg-[#0066FF] hover:bg-[#0052CC] text-white font-black uppercase tracking-widest text-xs transition-all active:scale-95 w-full sm:w-auto rounded-none"
                                    >
                                        Upgrade to Pro Plan <ArrowRight className="w-4 h-4" />
                                    </Link>
                                    <p className="text-slate-400 text-[10px] mt-4 uppercase tracking-[0.2em] font-bold">Cancel anytime • Secure via Stripe</p>
                                </div>
                            </div>
                        </div>
                    ) : (page < totalPages) && (
                        <div className="flex items-center justify-center pt-8">
                            <button
                                onClick={loadMore}
                                disabled={isFetching}
                                className="inline-flex items-center justify-center px-8 py-3 bg-white border border-[#0066FF]/20 hover:border-[#0066FF] text-[#0066FF] font-black uppercase tracking-widest text-[11px] sm:text-[12px] transition-all min-w-[180px] sm:min-w-[200px] disabled:opacity-70 disabled:cursor-not-allowed rounded-none shadow-xl shadow-[#0066FF]/5"
                            >
                                {isFetching ? (
                                    <span className="flex items-center gap-2">
                                        <span className="animate-pulse">Fetching...</span>
                                    </span>
                                ) : (
                                    <>
                                        Load More Jobs
                                        <ChevronRight className="w-4 h-4 ml-2" />
                                    </>
                                )}
                            </button>
                        </div>
                    )}
                </div>
            </div>

            {/* Job Details Panel */}
            {/* Mobile: Full-screen overlay when selected */}
            <div className={`fixed inset-0 z-[60] lg:relative lg:inset-auto lg:z-10 bg-black/40 lg:bg-transparent lg:block lg:w-[45%] lg:h-full ${isMobileDetailsOpen ? 'flex' : 'hidden'}`}>
                <div
                    className={`bg-white w-full h-full lg:h-full lg:border lg:border-[var(--border)] lg:rounded-md lg:shadow-sm overflow-hidden flex flex-col relative transition-transform duration-300 ${isMobileDetailsOpen ? 'translate-y-0' : 'translate-y-full lg:translate-y-0'}`}
                    onClick={(e) => e.stopPropagation()}
                >
                    {/* Mobile Close Button */}
                    <button
                        onClick={() => setIsMobileDetailsOpen(false)}
                        className="lg:hidden absolute top-4 right-4 z-[70] p-2 bg-slate-100 rounded-full text-slate-500"
                    >
                        <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12"></path></svg>
                    </button>

                    {!selectedJob ? (
                        <div className="flex-1 flex flex-col items-center justify-center text-center p-8 opacity-50">
                            <Briefcase className="w-12 h-12 sm:w-16 sm:h-16 text-slate-300 mb-4" />
                            <h3 className="text-lg sm:text-xl font-medium text-slate-800 dark:text-slate-200">Select a job</h3>
                            <p className="text-xs sm:text-sm text-slate-500 mt-2">Click on a job to view details</p>
                        </div>
                    ) : (
                        <div className="flex flex-col h-full overflow-hidden">
                            <div className="p-6 sm:p-7 overflow-y-auto flex-1">
                                <div className="pt-8 lg:pt-0">
                                    <h1 className="text-xl sm:text-2xl font-extrabold text-slate-900 mb-1 leading-tight">{selectedJob.title}</h1>
                                    <p className="text-slate-500 mb-6 font-medium text-[14px] sm:text-[15px]">{selectedJob.department || 'Engineering'} ({selectedJob.location || 'UK'})</p>

                                    {/* Checklist Area */}
                                    <div className="bg-[#0066FF]/5 border border-[#0066FF]/10 text-[#0066FF] p-4 sm:p-5 rounded-none space-y-3.5 mb-8">
                                        <div className="flex items-start gap-4 text-[12px] sm:text-[13px] font-bold uppercase tracking-wide">
                                            <CheckCircle2 className="w-5 h-5 text-[#0066FF] shrink-0" />
                                            <span>Licensed UK visa sponsor</span>
                                        </div>
                                        <div className="flex items-start gap-4 text-[12px] sm:text-[13px] font-bold uppercase tracking-wide">
                                            <TrendingUp className="w-5 h-5 text-[#0066FF] shrink-0" />
                                            <span>Matches your profile</span>
                                        </div>
                                    </div>

                                    {/* Company Box */}
                                    <div className="flex items-center gap-3 mb-4">
                                        <div className="w-8 h-8 sm:w-10 sm:h-10 rounded-md border border-[var(--border)] overflow-hidden bg-white flex items-center justify-center shrink-0">
                                            {selectedJob.company?.url_favicon ? (
                                                <img src={selectedJob.company.url_favicon} alt="logo" className="w-5 h-5 sm:w-6 sm:h-6 object-contain" />
                                            ) : (
                                                <Building className="w-5 h-5 sm:w-6 sm:h-6 text-slate-400" />
                                            )}
                                        </div>
                                        <h2 className="text-md sm:text-lg font-bold text-slate-900 truncate">{selectedJob.company?.trading_name}</h2>
                                    </div>

                                    <div className="flex gap-2 mb-8">
                                        <a href={selectedJob.company?.url || '#'} target="_blank" rel="noopener noreferrer" className="text-[11px] sm:text-xs bg-slate-100 hover:bg-slate-200 px-3 py-1.5 rounded-sm flex items-center gap-1.5 font-semibold text-slate-700 transition-colors">
                                            <LinkIcon className="w-3 h-3" /> Website
                                        </a>
                                        <a href={selectedJob.company?.url_linkedin || '#'} target="_blank" rel="noopener noreferrer" className="text-[11px] sm:text-xs bg-slate-100 hover:bg-slate-200 px-3 py-1.5 rounded-sm flex items-center gap-1.5 font-semibold text-slate-700 transition-colors">
                                            <Linkedin className="w-3 h-3" /> LinkedIn
                                        </a>
                                    </div>

                                    {/* About */}
                                    <div className="mb-12">
                                        <h3 className="font-semibold text-[14px] sm:text-[15px] mb-2 text-slate-900">About the company</h3>
                                        <p className="text-sm text-slate-600 leading-relaxed">
                                            {selectedJob.company?.description || `Explore fulfilling opportunities at ${selectedJob.company?.trading_name}. We are always interested in connecting with talented professionals.`}
                                        </p>
                                    </div>
                                </div>
                            </div>

                            {/* Sticky Footer Action */}
                            <div className="p-4 sm:p-5 border-t border-[var(--border)] bg-white flex flex-col gap-2 shrink-0 pb-24 sm:pb-5">
                                <a href={fixJobUrl(selectedJob.url)} target="_blank" rel="noopener noreferrer" className="w-full bg-[#0066FF] hover:bg-[#0052CC] text-white text-center py-3.5 sm:py-4 rounded-none font-black text-[12px] sm:text-[13px] uppercase tracking-widest flex items-center justify-center gap-2 transition-all shadow-xl shadow-[#0066FF]/20 active:scale-95">
                                    Apply now <ArrowRight className="w-4 h-4" />
                                </a>
                            </div>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}
