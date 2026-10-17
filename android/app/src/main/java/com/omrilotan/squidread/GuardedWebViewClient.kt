package com.omrilotan.squidread

import android.graphics.Bitmap
import android.net.Uri
import android.net.http.SslError
import android.os.Build
import android.os.Message
import android.view.KeyEvent
import android.webkit.ClientCertRequest
import android.webkit.HttpAuthHandler
import android.webkit.RenderProcessGoneDetail
import android.webkit.SafeBrowsingResponse
import android.webkit.SslErrorHandler
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.annotation.RequiresApi

/**
 * Wraps the client Readium gives each page's web view (API 26+, where it can be read back).
 *
 * - Books only navigate when the reader taps a link: a book's scripts, meta refreshes and
 *   iframes can't open other apps or leave the book. Links outside the book go to [onExternalLink].
 * - A crashed or killed web view renderer is reported to [onRendererGone] instead of taking the
 *   whole app down with it.
 *
 * Everything else is passed to Readium's client unchanged.
 */
@RequiresApi(Build.VERSION_CODES.O)
class GuardedWebViewClient(
	private val inner: WebViewClient,
	private val onExternalLink: (Uri) -> Unit,
	private val onRendererGone: (crashed: Boolean) -> Unit,
) : WebViewClient() {
	override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
		if (!request.hasGesture()) return true
		val url = request.url
		if (isInBook(url)) return inner.shouldOverrideUrlLoading(view, request)
		onExternalLink(url)
		return true
	}

	override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
		// The web view is dead; it must not be used again. The listener replaces it.
		onRendererGone(detail.didCrash())
		return true
	}

	override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? =
		inner.shouldInterceptRequest(view, request)

	override fun onPageStarted(view: WebView, url: String?, favicon: Bitmap?) = inner.onPageStarted(view, url, favicon)

	override fun onPageFinished(view: WebView, url: String?) = inner.onPageFinished(view, url)

	override fun onPageCommitVisible(view: WebView, url: String?) = inner.onPageCommitVisible(view, url)

	override fun onLoadResource(view: WebView, url: String?) = inner.onLoadResource(view, url)

	override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) =
		inner.onReceivedError(view, request, error)

	override fun onReceivedHttpError(view: WebView, request: WebResourceRequest, errorResponse: WebResourceResponse) =
		inner.onReceivedHttpError(view, request, errorResponse)

	override fun onReceivedSslError(view: WebView, handler: SslErrorHandler, error: SslError) =
		inner.onReceivedSslError(view, handler, error)

	override fun shouldOverrideKeyEvent(view: WebView, event: KeyEvent): Boolean = inner.shouldOverrideKeyEvent(view, event)

	override fun onUnhandledKeyEvent(view: WebView, event: KeyEvent) = inner.onUnhandledKeyEvent(view, event)

	override fun onScaleChanged(view: WebView, oldScale: Float, newScale: Float) = inner.onScaleChanged(view, oldScale, newScale)

	override fun doUpdateVisitedHistory(view: WebView, url: String?, isReload: Boolean) =
		inner.doUpdateVisitedHistory(view, url, isReload)

	override fun onFormResubmission(view: WebView, dontResend: Message, resend: Message) =
		inner.onFormResubmission(view, dontResend, resend)

	override fun onReceivedHttpAuthRequest(view: WebView, handler: HttpAuthHandler, host: String?, realm: String?) =
		inner.onReceivedHttpAuthRequest(view, handler, host, realm)

	override fun onReceivedClientCertRequest(view: WebView, request: ClientCertRequest) =
		inner.onReceivedClientCertRequest(view, request)

	override fun onReceivedLoginRequest(view: WebView, realm: String?, account: String?, args: String?) =
		inner.onReceivedLoginRequest(view, realm, account, args)

	@RequiresApi(Build.VERSION_CODES.O_MR1)
	override fun onSafeBrowsingHit(view: WebView, request: WebResourceRequest, threatType: Int, callback: SafeBrowsingResponse) =
		inner.onSafeBrowsingHit(view, request, threatType, callback)
}

/** The origins Readium serves the book and its own scripts from. */
private val BOOK_HOSTS = setOf("readium_package", "readium_assets")

/**
 * Whether [url] is part of the book. Outside [GuardedWebViewClient], which needs API 26, so
 * links can be checked on every Android version the app runs on.
 */
fun isInBook(url: Uri): Boolean = url.scheme == "https" && url.host in BOOK_HOSTS
