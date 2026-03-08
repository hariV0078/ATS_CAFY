'use client';

import { useState, useEffect, useRef } from 'react';
import Link from 'next/link';
import { Building, Globe, Linkedin, ChevronLeft, MapPin, Briefcase, ChevronRight, AlertTriangle, Star, ShieldCheck, TrendingUp, ArrowRight } from 'lucide-react';
import { getCompanies, Company, toggleFavoriteCompany, getFavoriteCompanyIds } from '../../app/actions/companyActions';
import { getJobs, Job } from '../../app/actions/jobActions';
import { getSubscriptionStatus } from '../../app/actions/subscriptionActions';

interface CompanyFeedProps {
    initialCompanies: Company[];
    initialTotalPages: number;
    searchParams: {
        q?: string;
        sort?: string;
    };
}

function fixJobUrl(url: string): string {
    if (!url) return '#';
    if (url.includes('api.smartrecruiters.com')) {
        const match = url.match(/\/companies\/([^/]+)\/postings\/([^/?#]+)/);
        if (match) return `https://jobs.smartrecruiters.com/${match[1]}/${match[2]}`;
    }
    return url;
}

export default function CompanyFeed({ initialCompanies, initialTotalPages, searchParams }: CompanyFeedProps) {
    const [companies, setCompanies] = useState<Company[]>(initialCompanies);
    const [isPro, setIsPro] = useState(true);
    const [page, setPage] = useState(1);
    const [isFetchingCompanies, setIsFetchingCompanies] = useState(false);
    const [q, setQ] = useState(searchParams.q || '');
    const [sort, setSort] = useState(searchParams.sort || 'alphabetical');
    const [showFavorites, setShowFavorites] = useState(false);
    const [selectedCompanyId, setSelectedCompanyId] = useState<number | null>(
        initialCompanies.length > 0 ? initialCompanies[0].id : null
    );
    const [isDescExpanded, setIsDescExpanded] = useState(false);
    const [viewState, setViewState] = useState<'details' | 'roles'>('details');
    const [companyJobs, setCompanyJobs] = useState<Job[]>([]);
    const [companyJobsPage, setCompanyJobsPage] = useState(1);
    const [companyJobsTotalPages, setCompanyJobsTotalPages] = useState(0);
    const [isFetchingJobs, setIsFetchingJobs] = useState(false);
    const [seenCompanyIds, setSeenCompanyIds] = useState<number[]>(initialCompanies.map(c => c.id));
    const [favoriteIds, setFavoriteIds] = useState<number[]>([]);
    const [isMobileDetailsOpen, setIsMobileDetailsOpen] = useState(false);

    const totalPages = initialTotalPages;
    const searchTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    useEffect(() => {
        setIsDescExpanded(false);
        setViewState('details');
        setCompanyJobs([]);
    }, [selectedCompanyId]);

    useEffect(() => {
        getSubscriptionStatus().then(res => setIsPro(res.isPro));
    }, []);

    useEffect(() => {
        setCompanies(initialCompanies);
        setPage(1);
        setSeenCompanyIds(initialCompanies.map(c => c.id));
        if (initialCompanies.length > 0) setSelectedCompanyId(initialCompanies[0].id);
        else setSelectedCompanyId(null);

        // Load favorite IDs on mount
        getFavoriteCompanyIds().then(setFavoriteIds);
    }, [initialCompanies]);

    const selectedCompany = companies.find(c => c.id === selectedCompanyId);

    const handleCompanyClick = (companyId: number) => {
        setSelectedCompanyId(companyId);
        setIsMobileDetailsOpen(true);
    };

    const doSearch = async (newQ: string, newSort: string, favsOnly: boolean = showFavorites) => {
        try {
            const data = await getCompanies({
                q: newQ,
                sort: newSort,
                page: 1,
                favoritesOnly: favsOnly
            });
            if (data?.companies) {
                const list = data.companies as Company[];
                setCompanies(list);
                setPage(1);
                setSeenCompanyIds(list.map(c => c.id));
                setSelectedCompanyId(list.length > 0 ? list[0].id : null);
            }
        } catch (e) { console.error(e); }
    };

    const handleSearch = (val: string) => {
        setQ(val);
        if (searchTimeoutRef.current) clearTimeout(searchTimeoutRef.current);
        searchTimeoutRef.current = setTimeout(() => doSearch(val, sort, showFavorites), 400);
    };

    const handleSort = (val: string) => {
        setSort(val);
        doSearch(q, val, showFavorites);
    };

    const toggleShowFavorites = () => {
        const newVal = !showFavorites;
        setShowFavorites(newVal);
        doSearch(q, sort, newVal);
    };

    const loadMoreCompanies = async () => {
        setIsFetchingCompanies(true);
        try {
            const nextPage = page + 1;
            const data = await getCompanies({
                q,
                sort,
                page: nextPage,
                excludedCompanyIds: seenCompanyIds,
                favoritesOnly: showFavorites
            });
            if (data?.companies) {
                const newOnes = data.companies as Company[];
                setCompanies(prev => [...prev, ...newOnes]);
                setSeenCompanyIds(prev => [...prev, ...newOnes.map(c => c.id)]);
                setPage(nextPage);
            }
        } catch (e) { console.error(e); }
        finally { setIsFetchingCompanies(false); }
    };

    const handleToggleFavorite = async (e: React.MouseEvent, companyId: number) => {
        e.stopPropagation();
        try {
            const { isFavorite } = await toggleFavoriteCompany(companyId);
            if (isFavorite) {
                setFavoriteIds(prev => [...prev, companyId]);
                if (showFavorites) {
                    // Try to find the company to add it back if it was locally removed
                    const companyToAdd = initialCompanies.find(c => c.id === companyId) || selectedCompany;
                    if (companyToAdd && companyToAdd.id === companyId) {
                        setCompanies(prev => {
                            if (!prev.find(c => c.id === companyId)) {
                                return [companyToAdd, ...prev];
                            }
                            return prev;
                        });
                    }
                }
            } else {
                setFavoriteIds(prev => prev.filter(id => id !== companyId));
                if (showFavorites) {
                    setCompanies(prev => prev.filter(c => c.id !== companyId));
                    if (selectedCompanyId === companyId) {
                        setSelectedCompanyId(null);
                    }
                }
            }
        } catch (e) { console.error(e); }
    };

    const handleViewRoles = async () => {
        if (!selectedCompanyId) return;
        setViewState('roles');
        setIsFetchingJobs(true);
        setCompanyJobsPage(1);
        try {
            const data = await getJobs({ company_id: selectedCompanyId, page: 1 });
            if (data?.jobs) {
                setCompanyJobs(data.jobs as Job[]);
                setCompanyJobsTotalPages(data.totalPages || 0);
            }
        } catch (e) { console.error(e); }
        finally { setIsFetchingJobs(false); }
    };

    const loadMoreCompanyJobs = async () => {
        if (!selectedCompanyId) return;
        setIsFetchingJobs(true);
        try {
            const nextPage = companyJobsPage + 1;
            const data = await getJobs({ company_id: selectedCompanyId, page: nextPage });
            if (data?.jobs) {
                setCompanyJobs(prev => [...prev, ...(data.jobs as Job[])]);
                setCompanyJobsPage(nextPage);
                setCompanyJobsTotalPages(data.totalPages || 0);
            }
        } catch (e) { console.error(e); }
        finally { setIsFetchingJobs(false); }
    };

    return (
        <div className="flex h-full overflow-hidden bg-white lg:rounded-xl lg:shadow-sm lg:border lg:border-[var(--border)] lg:mb-6">
            {/* ── Middle: Company List ── */}
            <div className="flex flex-col flex-1 lg:border-r border-[var(--border)] overflow-hidden min-w-0">

                {/* Search + filters */}
                <div className="border-b border-[var(--border)] px-4 py-3 space-y-2 bg-[var(--background)] shrink-0 mt-2 lg:mt-0">
                    {isPro && (
                        <div className="relative">
                            <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                            </svg>
                            <input
                                type="text"
                                value={q}
                                onChange={e => handleSearch(e.target.value)}
                                placeholder='Search for a company or industry...'
                                className="w-full pl-9 pr-4 py-2 text-sm border border-[var(--border)] rounded-md bg-white focus:outline-none focus:ring-1 focus:ring-brand-500 text-slate-700 placeholder-slate-400"
                            />
                        </div>
                    )}
                    {isPro && (
                        <div className="flex flex-col lg:flex-row lg:items-center gap-3 lg:gap-6 text-sm text-slate-500">
                            <div className="flex items-center gap-1">
                                <span>Company size</span>
                                <select className="border border-[var(--border)] bg-white text-slate-700 font-medium text-xs focus:outline-none cursor-pointer ml-1 p-1 rounded">
                                    <option>Any</option>
                                    <option>Small</option>
                                    <option>Medium</option>
                                    <option>Large</option>
                                </select>
                            </div>

                            <div className="flex items-center">
                                <button
                                    onClick={toggleShowFavorites}
                                    className={`flex items-center gap-1.5 px-2.5 py-1 rounded border text-xs font-semibold transition-colors ${showFavorites
                                        ? 'bg-amber-50 border-amber-200 text-amber-600'
                                        : 'bg-white border-[var(--border)] text-slate-500 hover:bg-slate-50'
                                        }`}
                                >
                                    <Star className={`w-3.5 h-3.5 ${showFavorites ? 'fill-current text-amber-500' : 'text-slate-400'}`} />
                                    Favorites only
                                </button>
                            </div>
                        </div>
                    )}
                </div>

                {/* List */}
                <div className="flex-1 overflow-y-auto pb-32 lg:pb-0">
                    {companies.length === 0 ? (
                        <div className="text-center py-20 text-slate-500">
                            <Building className="w-10 h-10 mx-auto text-slate-300 mb-3" />
                            <p>No companies found.</p>
                        </div>
                    ) : (
                        <>
                            {companies.map(company => {
                                const isSelected = selectedCompanyId === company.id;
                                return (
                                    <div
                                        key={company.id}
                                        onClick={() => handleCompanyClick(company.id)}
                                        className={`group px-4 py-4 border-b border-[var(--border)] cursor-pointer transition-all
                                            border-l-2 ${isSelected
                                                ? 'bg-blue-50/60 border-l-[#137cdb]'
                                                : 'bg-white hover:bg-slate-50/70 border-l-transparent'}`}
                                    >
                                        <div className="flex items-start gap-3">
                                            {/* Logo tile — larger with letter fallback */}
                                            <div className="w-10 h-10 rounded-lg border border-[var(--border)] bg-slate-50 flex items-center justify-center shrink-0 overflow-hidden shadow-sm">
                                                {company.url_favicon ? (
                                                    <img src={company.url_favicon} alt="" className="w-6 h-6 object-contain" />
                                                ) : (
                                                    <span className="text-sm font-bold text-slate-400">
                                                        {company.trading_name.charAt(0)}
                                                    </span>
                                                )}
                                            </div>

                                            <div className="flex-1 min-w-0">
                                                {/* Name + role count */}
                                                <div className="flex items-start justify-between gap-2">
                                                    <div className="min-w-0">
                                                        <h3 className="font-bold text-[14px] text-slate-900 leading-tight truncate">{company.trading_name}</h3>
                                                        {company.companies_house_name && (
                                                            <p className="text-[11px] text-slate-400 truncate">{company.companies_house_name}</p>
                                                        )}
                                                    </div>
                                                    <div className="flex items-center gap-2">
                                                        {/* Favorite star */}
                                                        <button
                                                            onClick={(e) => handleToggleFavorite(e, company.id)}
                                                            className={`p-1 rounded-full hover:bg-slate-100 transition-colors ${favoriteIds.includes(company.id) ? 'text-amber-400' : 'text-slate-300'}`}
                                                        >
                                                            <Star className={`w-4 h-4 ${favoriteIds.includes(company.id) ? 'fill-current' : ''}`} />
                                                        </button>
                                                        {/* Prominent role count pill */}
                                                        {(company.active_jobs_count || 0) > 0 && (
                                                            <span className="shrink-0 text-[11px] font-semibold text-[#137cdb] bg-blue-50 border border-blue-100 px-2 py-0.5 rounded-full whitespace-nowrap">
                                                                {company.active_jobs_count} roles
                                                            </span>
                                                        )}
                                                    </div>
                                                </div>

                                                {/* 2-line description */}
                                                {company.description && (
                                                    <p className="text-[12px] text-slate-500 mt-1.5 line-clamp-2 leading-relaxed">
                                                        {company.description}
                                                    </p>
                                                )}

                                                {/* Badges — flat rectangular style */}
                                                <div className="flex flex-wrap gap-1.5 mt-2">
                                                    {company.licensed_sponsor && (
                                                        <span className="inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-sm bg-[#137cdb] text-white tracking-wide">
                                                            ✓ Licensed sponsor
                                                        </span>
                                                    )}
                                                    {company.estimated_num_employees_label && (
                                                        <span className="inline-flex items-center text-[10px] font-medium px-2 py-0.5 rounded-sm bg-slate-100 text-slate-500 border border-slate-200">
                                                            {company.estimated_num_employees_label}
                                                        </span>
                                                    )}
                                                </div>
                                            </div>
                                        </div>
                                    </div>
                                );
                            })}

                            {/* Load More or Upgrade */}
                            {!isPro && companies.length >= 5 ? (
                                <div className="px-4 py-8 border-t border-[var(--border)]">
                                    <div className="bg-gradient-to-br from-slate-900 to-slate-800 border border-slate-700 rounded-lg p-8 shadow-2xl relative overflow-hidden group">
                                        <div className="absolute top-0 right-0 p-4 opacity-10 group-hover:opacity-20 transition-opacity">
                                            <Building className="w-32 h-32 text-white rotate-12" />
                                        </div>
                                        <div className="relative z-10 text-center sm:text-left">
                                            <div className="flex flex-col sm:flex-row items-center gap-4 mb-4">
                                                <div className="p-3 bg-[#137cdb] rounded-xl shadow-lg shadow-[#137cdb]/20">
                                                    <TrendingUp className="w-6 h-6 text-white" />
                                                </div>
                                                <h3 className="text-xl sm:text-2xl font-black text-white uppercase tracking-tight">Unlock 2,500+ Companies</h3>
                                            </div>
                                            <p className="text-slate-300 mb-8 max-w-md leading-relaxed text-sm sm:text-base">
                                                You've reached the limit for free users. Upgrade to Pro for just <span className="text-brand-400 font-bold">£0.99/week</span> to browse and search our entire database of tiered sponsors.
                                            </p>
                                            <Link
                                                href="/account/subscription"
                                                className="inline-flex items-center justify-center gap-2 px-8 py-4 bg-[#137cdb] hover:bg-blue-600 text-white font-black uppercase tracking-widest text-xs transition-all shadow-xl active:scale-95 w-full sm:w-auto rounded-none"
                                            >
                                                Upgrade to Pro Plan <ArrowRight className="w-4 h-4" />
                                            </Link>
                                            <p className="text-slate-500 text-[10px] mt-4 uppercase tracking-[0.2em] font-bold">Cancel anytime • Secure payment via Stripe</p>
                                        </div>
                                    </div>
                                </div>
                            ) : page < totalPages && (
                                <div className="flex justify-center py-6">
                                    <button
                                        onClick={loadMoreCompanies}
                                        disabled={isFetchingCompanies}
                                        className="flex items-center gap-2 px-6 py-2 border border-[var(--border)] rounded-md text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50 transition-colors"
                                    >
                                        {isFetchingCompanies ? 'Loading...' : <><ChevronRight className="w-4 h-4" /> Load more companies</>}
                                    </button>
                                </div>
                            )}
                        </>
                    )}
                </div>
            </div>

            {/* ── Right: Detail Panel ── */}
            <div className={`fixed inset-0 z-[60] lg:relative lg:inset-auto lg:z-10 bg-black/40 lg:bg-transparent lg:block lg:w-[500px] xl:w-[650px] lg:shrink-0 lg:overflow-hidden lg:h-full ${isMobileDetailsOpen ? 'flex' : 'hidden'}`}>
                <div
                    className={`bg-white w-full h-full lg:h-full lg:border-l lg:border-[var(--border)] overflow-hidden flex flex-col relative transition-transform duration-300 ${isMobileDetailsOpen ? 'translate-y-0' : 'translate-y-full lg:translate-y-0'}`}
                    onClick={(e) => e.stopPropagation()}
                >
                    {/* Mobile Close Button */}
                    <button
                        onClick={() => setIsMobileDetailsOpen(false)}
                        className="lg:hidden absolute top-4 right-4 z-[70] p-2 bg-slate-100 hover:bg-slate-200 rounded-full text-slate-500"
                    >
                        <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12"></path></svg>
                    </button>

                    {!selectedCompany ? (
                        <div className="flex-1 flex flex-col items-center justify-center text-center p-8 opacity-40">
                            <Building className="w-12 h-12 text-slate-300 mb-3" />
                            <p className="text-slate-500 text-sm">Select a company to view details</p>
                        </div>
                    ) : viewState === 'details' ? (
                        <div className="flex-1 overflow-y-auto p-6 sm:p-8">
                            {/* Header */}
                            <div className="flex items-center gap-4 mb-4 mt-6 lg:mt-0">
                                <div className="w-12 h-12 rounded-xl border border-[var(--border)] bg-slate-50 flex items-center justify-center shrink-0 overflow-hidden shadow-sm">
                                    {selectedCompany.url_favicon ? (
                                        <img src={selectedCompany.url_favicon} alt="" className="w-8 h-8 object-contain" />
                                    ) : (
                                        <span className="text-lg font-bold text-slate-400">{selectedCompany.trading_name.charAt(0)}</span>
                                    )}
                                </div>
                                <div className="flex-1">
                                    <h2 className="font-extrabold text-xl text-slate-900 leading-tight">{selectedCompany.trading_name}</h2>
                                    {selectedCompany.companies_house_name && (
                                        <p className="text-xs text-slate-400 font-medium uppercase tracking-wide mt-1">{selectedCompany.companies_house_name}</p>
                                    )}
                                </div>
                            </div>

                            {/* Links */}
                            <div className="flex flex-wrap items-center gap-3 mt-4 mb-6">
                                {selectedCompany.url && (
                                    <a href={selectedCompany.url} target="_blank" rel="noopener noreferrer" className="flex items-center justify-center gap-1.5 text-xs font-semibold bg-slate-100 hover:bg-slate-200 text-slate-700 px-3 py-1.5 rounded-sm transition-colors">
                                        <Globe className="w-3.5 h-3.5" /> Website
                                    </a>
                                )}
                                {selectedCompany.url_linkedin && (
                                    <a href={selectedCompany.url_linkedin} target="_blank" rel="noopener noreferrer" className="flex items-center justify-center gap-1.5 text-xs font-semibold bg-slate-100 hover:bg-slate-200 text-slate-700 px-3 py-1.5 rounded-sm transition-colors">
                                        <Linkedin className="w-3.5 h-3.5" /> LinkedIn
                                    </a>
                                )}
                            </div>

                            <button className="flex items-center gap-1.5 text-[11px] text-slate-400 hover:text-red-500 mb-6 transition-colors">
                                <AlertTriangle className="w-3 h-3" /> Report company no longer exists
                            </button>

                            {/* About */}
                            <div className="border-t border-[var(--border)] pt-6">
                                <h3 className="font-bold text-[15px] sm:text-[16px] text-slate-900 mb-3">About the company</h3>
                                <p className={`text-[14px] text-slate-600 leading-relaxed ${!isDescExpanded ? 'line-clamp-4' : ''}`}>
                                    {selectedCompany.description || `Explore fulfilling opportunities at ${selectedCompany.trading_name}. We are always interested in connecting with talented professionals.`}
                                </p>
                                {(selectedCompany.description || '').length > 220 && (
                                    <button
                                        onClick={() => setIsDescExpanded(!isDescExpanded)}
                                        className="text-sm text-[#0066FF] font-semibold mt-2 hover:underline"
                                    >
                                        {isDescExpanded ? 'Read less' : 'Read more'}
                                    </button>
                                )}
                            </div>

                            {/* View Roles CTA */}
                            {(selectedCompany.active_jobs_count || 0) > 0 && (
                                <div className="mt-8">
                                    <button
                                        onClick={handleViewRoles}
                                        className="w-full py-3.5 sm:py-4 rounded-none text-[12px] sm:text-[13px] font-black uppercase tracking-widest transition-all shadow-xl active:scale-95 bg-[#0066FF] hover:bg-[#0052CC] text-white shadow-[#0066FF]/20"
                                    >
                                        View {selectedCompany.active_jobs_count} open roles
                                    </button>
                                </div>
                            )}
                        </div>
                    ) : (
                        /* Roles view */
                        <div className="flex flex-col h-full bg-slate-50 lg:bg-white pb-24 lg:pb-0">
                            <div className="flex items-center gap-3 px-5 py-5 border-b border-[var(--border)] bg-white shrink-0 shadow-sm z-10">
                                <button onClick={() => setViewState('details')} className="p-1.5 text-slate-500 hover:text-slate-800 hover:bg-slate-100 rounded-full transition-colors">
                                    <ChevronLeft className="w-5 h-5" />
                                </button>
                                <div>
                                    <h3 className="font-bold text-[15px] text-slate-900 leading-none mb-1">Jobs at {selectedCompany.trading_name}</h3>
                                    <p className="text-[11px] font-medium uppercase tracking-wider text-slate-500">
                                        {(selectedCompany.active_jobs_count || 0) > 0 ? `${selectedCompany.active_jobs_count} open roles` : 'No open roles'}
                                    </p>
                                </div>
                            </div>

                            <div className="flex-1 overflow-y-auto p-4 sm:p-5 space-y-3">
                                {isFetchingJobs ? (
                                    <div className="flex justify-center items-center h-40">
                                        <div className="w-8 h-8 border-4 border-[#0066FF] border-t-transparent rounded-full animate-spin" />
                                    </div>
                                ) : companyJobs.length === 0 ? (
                                    <div className="text-center py-16 text-slate-500 bg-white border border-dashed border-[var(--border)] rounded-md">
                                        <Briefcase className="w-12 h-12 mx-auto text-slate-300 mb-4" />
                                        <h3 className="text-[15px] font-medium text-slate-900 mb-1">No open roles</h3>
                                        <p className="text-[13px] text-slate-500 mt-2 max-w-xs mx-auto px-4">
                                            Try adjusting your filters or <Link href="/account/preferences" className="text-[#0066FF] font-medium hover:underline">update your preferences</Link>.
                                        </p>
                                    </div>
                                ) : (
                                    <>
                                        {companyJobs.map(job => (
                                            <a
                                                key={job.id}
                                                href={fixJobUrl(job.url)}
                                                target="_blank"
                                                rel="noopener noreferrer"
                                                className="block bg-white border border-[var(--border)] p-4 sm:p-5 rounded-md hover:border-[#0066FF]/40 hover:shadow-md transition-all group"
                                            >
                                                <h4 className="font-bold text-[15px] text-slate-900 group-hover:text-[#0066FF] leading-snug mb-2 transition-colors">
                                                    {job.title}
                                                </h4>
                                                <div className="flex items-center gap-3 text-[12px] font-medium text-slate-500 flex-wrap">
                                                    <span className="flex items-center gap-1.5 bg-slate-100 px-2 py-1 rounded-sm"><MapPin className="w-3.5 h-3.5 text-slate-400" />{job.location || 'UK'}</span>
                                                    {job.department && <span className="flex items-center gap-1.5"><Briefcase className="w-3.5 h-3.5" />{job.department}</span>}
                                                </div>
                                            </a>
                                        ))}
                                        {companyJobsPage < companyJobsTotalPages && (
                                            <button
                                                onClick={loadMoreCompanyJobs}
                                                disabled={isFetchingJobs}
                                                className="w-full mt-4 py-3 bg-white border border-[#0066FF]/20 hover:border-[#0066FF] text-[#0066FF] font-black uppercase tracking-widest text-[11px] transition-all rounded-none disabled:opacity-50"
                                            >
                                                {isFetchingJobs ? 'Loading...' : 'Load more roles'}
                                            </button>
                                        )}
                                    </>
                                )}
                            </div>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}
