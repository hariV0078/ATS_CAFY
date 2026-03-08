'use client';

import { useEffect, useState } from 'react';
import { getReportedJobsAdmin, deleteJobAdmin, dismissReportAdmin } from './actions';
import { Trash2, XCircle, ExternalLink, AlertTriangle } from 'lucide-react';

interface ReportedJob {
    id: number;
    created_at: string;
    job_id: number;
    jobs: {
        id: number;
        title: string;
        url: string;
        company_id: number;
        companies: {
            trading_name: string;
        };
    } | null;
}

export default function ReportedJobsAdmin() {
    const [reports, setReports] = useState<ReportedJob[]>([]);
    const [loading, setLoading] = useState(true);

    const fetchReports = async () => {
        setLoading(true);
        const res = await getReportedJobsAdmin();
        if (res.success && res.data) {
            setReports(res.data as any);
        }
        setLoading(false);
    };

    useEffect(() => {
        fetchReports();
    }, []);

    const handleDeleteJob = async (jobId: number) => {
        if (!confirm('Are you sure you want to delete this job AND all its reports?')) return;

        const res = await deleteJobAdmin(jobId);
        if (res.success) {
            setReports(prev => prev.filter(r => r.job_id !== jobId));
        } else {
            alert(res.error || 'Failed to delete job');
        }
    };

    const handleDismissReport = async (reportId: number) => {
        const res = await dismissReportAdmin(reportId);
        if (res.success) {
            setReports(prev => prev.filter(r => r.id !== reportId));
        } else {
            alert(res.error || 'Failed to dismiss report');
        }
    };

    if (loading) {
        return <div className="p-8 text-center text-slate-500 animate-pulse">Loading reports...</div>;
    }

    return (
        <div className="max-w-6xl mx-auto p-6 mt-16 sm:mt-20">
            <div className="flex items-center gap-3 mb-8">
                <div className="p-2 sm:p-3 bg-red-100 rounded-md">
                    <AlertTriangle className="w-5 h-5 sm:w-6 sm:h-6 text-red-600" />
                </div>
                <div>
                    <h1 className="text-xl sm:text-2xl font-black text-slate-900 uppercase tracking-tight">Reported Jobs</h1>
                    <p className="text-sm text-slate-500 font-medium">Manage jobs that users have flagged as expired or broken</p>
                </div>
            </div>

            {reports.length === 0 ? (
                <div className="bg-white border rounded-md p-12 text-center text-slate-500 shadow-sm">
                    No active reports.
                </div>
            ) : (
                <div className="bg-white border rounded-md overflow-hidden shadow-sm">
                    <div className="overflow-x-auto">
                        <table className="w-full text-left text-sm">
                            <thead className="bg-slate-50 text-slate-600 font-bold uppercase tracking-wider text-xs border-b">
                                <tr>
                                    <th className="p-4">Report Date</th>
                                    <th className="p-4">Company</th>
                                    <th className="p-4">Job Title</th>
                                    <th className="p-4 text-right">Actions</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-slate-100">
                                {reports.map((report) => (
                                    <tr key={report.id} className="hover:bg-slate-50/50 transition-colors">
                                        <td className="p-4 text-slate-500 font-medium whitespace-nowrap">
                                            {new Date(report.created_at).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })}
                                        </td>
                                        <td className="p-4 font-semibold text-slate-900">
                                            {report.jobs?.companies?.trading_name || 'Unknown'}
                                        </td>
                                        <td className="p-4">
                                            {report.jobs ? (
                                                <div className="flex items-center gap-2">
                                                    <a href={report.jobs.url} target="_blank" rel="noopener noreferrer" className="text-[#0066FF] hover:underline font-bold flex items-center gap-1">
                                                        {report.jobs.title}
                                                        <ExternalLink className="w-3 h-3" />
                                                    </a>
                                                    <span className="text-xs text-slate-400 font-mono bg-slate-100 px-1.5 py-0.5 rounded-sm">ID: {report.jobs.id}</span>
                                                </div>
                                            ) : (
                                                <span className="text-red-500 italic">Job not found</span>
                                            )}
                                        </td>
                                        <td className="p-4 text-right space-x-2 whitespace-nowrap">
                                            <button
                                                onClick={() => handleDismissReport(report.id)}
                                                className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-bold rounded-sm transition-colors"
                                                title="Dismiss this report only"
                                            >
                                                <XCircle className="w-3.5 h-3.5" /> Dismiss
                                            </button>
                                            <button
                                                onClick={() => report.jobs && handleDeleteJob(report.jobs.id)}
                                                disabled={!report.jobs}
                                                className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-red-50 hover:bg-red-100 text-red-600 border border-red-100 text-xs font-bold rounded-sm transition-colors disabled:opacity-50"
                                                title="Delete the job entirely from database"
                                            >
                                                <Trash2 className="w-3.5 h-3.5" /> Delete Job
                                            </button>
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                </div>
            )}
        </div>
    );
}
