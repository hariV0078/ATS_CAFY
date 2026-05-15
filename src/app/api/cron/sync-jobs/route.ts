import { NextRequest, NextResponse } from 'next/server';
import { syncAll } from '@/scripts/syncAll';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

function isAuthorized(req: NextRequest): boolean {
    const secret = process.env.CRON_SECRET;
    if (!secret) return false;

    const authHeader = req.headers.get('authorization');
    const bearer = authHeader?.startsWith('Bearer ') ? authHeader.slice('Bearer '.length) : null;
    const headerSecret = req.headers.get('x-cron-secret');

    return bearer === secret || headerSecret === secret;
}

export async function GET(req: NextRequest) {
    if (!isAuthorized(req)) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const startedAt = Date.now();

    try {
        await syncAll();
        const durationMs = Date.now() - startedAt;
        return NextResponse.json({ ok: true, task: 'sync-jobs', durationMs });
    } catch (error) {
        console.error('sync-jobs cron failed:', error);
        return NextResponse.json(
            {
                ok: false,
                task: 'sync-jobs',
                error: error instanceof Error ? error.message : String(error),
            },
            { status: 500 }
        );
    }
}
