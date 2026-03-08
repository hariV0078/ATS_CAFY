import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'

export async function updateSession(request: NextRequest) {
    let supabaseResponse = NextResponse.next({
        request,
    })

    const supabase = createServerClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL!,
        process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
        {
            cookies: {
                getAll() {
                    return request.cookies.getAll()
                },
                setAll(cookiesToSet) {
                    cookiesToSet.forEach(({ name, value, options }) => request.cookies.set(name, value))
                    supabaseResponse = NextResponse.next({
                        request,
                    })
                    cookiesToSet.forEach(({ name, value, options }) =>
                        supabaseResponse.cookies.set(name, value, options)
                    )
                },
            },
        }
    )

    // This will refresh session if expired
    const {
        data: { user },
    } = await supabase.auth.getUser()

    // Auth guard logic
    const { pathname } = request.nextUrl

    // Core auth pages that should NOT require authentication
    // but should redirect authenticated users away
    const isAuthPage =
        pathname === '/login' ||
        pathname === '/signup' ||
        pathname === '/forgot-password' ||
        pathname === '/reset-password'

    const isApi = pathname.startsWith('/api')
    const isDebug = pathname === '/debug-db'
    const isCallback = pathname.startsWith('/auth/callback')

    if (!user) {
        // If they are not logged in and not on an auth page/callback/api/debug, redirect to login
        if (!isAuthPage && !isCallback && !isApi && !isDebug) {
            const url = request.nextUrl.clone()
            url.pathname = '/login'
            return NextResponse.redirect(url)
        }
    } else {
        // If they are logged in but trying to hit an auth page, redirect to home
        if (isAuthPage) {
            const url = request.nextUrl.clone()
            url.pathname = '/'
            return NextResponse.redirect(url)
        }
    }

    return supabaseResponse
}
