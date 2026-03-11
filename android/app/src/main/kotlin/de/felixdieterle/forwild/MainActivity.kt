package de.felixdieterle.forwild

import android.Manifest
import android.annotation.SuppressLint
import android.content.pm.PackageManager
import android.location.Location
import android.os.Bundle
import android.webkit.JavascriptInterface
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import androidx.webkit.WebViewAssetLoader
import com.google.android.gms.location.CurrentLocationRequest
import com.google.android.gms.location.FusedLocationProviderClient
import com.google.android.gms.location.LocationCallback
import com.google.android.gms.location.LocationRequest
import com.google.android.gms.location.LocationResult
import com.google.android.gms.location.LocationServices
import com.google.android.gms.location.Priority
import org.json.JSONObject

/**
 * Main activity for the 4TheWild native Android app.
 *
 * The app's UI is rendered in an Android WebView that loads the bundled
 * HTML/CSS/JavaScript assets. A JavaScript bridge (AndroidBridge) exposes
 * native geolocation capabilities so the web layer can request GPS
 * permissions and receive position updates without any third-party wrapper
 * framework.
 *
 * The bridge is registered as `window.Android` in the WebView and exposes:
 *   Android.getCurrentPosition(callbackId, highAccuracy)
 *   Android.watchPosition(callbackId, highAccuracy)
 *   Android.clearWatch(watchId)
 *   Android.checkPermissions(callbackId)
 *   Android.requestPermissions(callbackId)
 *
 * Results are delivered back to JS via:
 *   window._androidGeoCallback(id, errorOrNull, resultOrNull)
 */
class MainActivity : AppCompatActivity() {

    companion object {
        private const val LOCATION_PERMISSION_REQUEST = 1001
    }

    private lateinit var webView: WebView
    private lateinit var fusedLocationClient: FusedLocationProviderClient

    /** One-shot position requests that arrived before permission was granted. */
    private val pendingPositionRequests = mutableListOf<Pair<String, Boolean>>()

    /** Ongoing watch requests that arrived before permission was granted. */
    private val pendingWatchRequests = mutableListOf<Pair<String, Boolean>>()

    /** Permission callbacks waiting for the user's response in the OS dialog. */
    private val pendingPermissionCallbacks = mutableListOf<String>()

    /** Active watchPosition: the callback ID used as the watch handle. */
    private var watchCallbackId: String? = null
    private var locationCallback: LocationCallback? = null

    // ── Lifecycle ──────────────────────────────────────────────────────

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        fusedLocationClient = LocationServices.getFusedLocationProviderClient(this)
        webView = findViewById(R.id.webView)

        // Serve local assets via https://appassets.androidplatform.net so that
        // the same-origin policy does not block outbound network requests
        // (e.g., Overpass API, OpenStreetMap tiles).
        val assetLoader = WebViewAssetLoader.Builder()
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this))
            .build()

        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            allowFileAccess = false
            mediaPlaybackRequiresUserGesture = false
            mixedContentMode = WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE
        }

        webView.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(
                view: WebView,
                request: WebResourceRequest,
            ): WebResourceResponse? = assetLoader.shouldInterceptRequest(request.url)
        }

        webView.webChromeClient = WebChromeClient()
        webView.addJavascriptInterface(AndroidBridge(), "Android")

        webView.loadUrl("https://appassets.androidplatform.net/assets/www/index.html")
    }

    override fun onDestroy() {
        super.onDestroy()
        clearWatchInternal()
    }

    // ── Permission result ──────────────────────────────────────────────

    override fun onRequestPermissionsResult(
        requestCode: Int,
        permissions: Array<String>,
        grantResults: IntArray,
    ) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode != LOCATION_PERMISSION_REQUEST) return

        val granted = grantResults.isNotEmpty() &&
            grantResults[0] == PackageManager.PERMISSION_GRANTED
        val state = if (granted) "granted" else "denied"

        // Resolve all waiting permission callbacks.
        pendingPermissionCallbacks.forEach { id ->
            deliverResult(id, JSONObject().put("state", state))
        }
        pendingPermissionCallbacks.clear()

        // Fulfil any one-shot position requests that were queued.
        if (granted) {
            pendingPositionRequests.forEach { (id, highAccuracy) ->
                fetchLocation(id, highAccuracy)
            }
            pendingWatchRequests.forEach { (id, highAccuracy) ->
                startWatch(id, highAccuracy)
            }
        } else {
            pendingPositionRequests.forEach { (id, _) ->
                deliverError(id, 1, "Location permission denied")
            }
            pendingWatchRequests.forEach { (id, _) ->
                deliverError(id, 1, "Location permission denied")
            }
        }
        pendingPositionRequests.clear()
        pendingWatchRequests.clear()
    }

    // ── Internal helpers ───────────────────────────────────────────────

    private fun hasLocationPermission() =
        ContextCompat.checkSelfPermission(
            this, Manifest.permission.ACCESS_FINE_LOCATION,
        ) == PackageManager.PERMISSION_GRANTED

    private fun requestLocationPermission() {
        ActivityCompat.requestPermissions(
            this,
            arrayOf(
                Manifest.permission.ACCESS_FINE_LOCATION,
                Manifest.permission.ACCESS_COARSE_LOCATION,
            ),
            LOCATION_PERMISSION_REQUEST,
        )
    }

    /**
     * Deliver a successful result to the JavaScript callback registry.
     * @param persistent  When true the entry is not removed after the first
     *                    delivery (used for ongoing watchPosition updates).
     */
    private fun deliverResult(id: String, result: JSONObject, persistent: Boolean = false) {
        val p = if (persistent) "true" else "false"
        val js = "window._androidGeoCallback('$id',null,$result,$p)"
        webView.post { webView.evaluateJavascript(js, null) }
    }

    /** Deliver an error to the JavaScript callback registry. */
    private fun deliverError(id: String, code: Int, message: String) {
        val err = JSONObject().put("code", code).put("message", message)
        val js = "window._androidGeoCallback('$id',$err,null,false)"
        webView.post { webView.evaluateJavascript(js, null) }
    }

    /**
     * Build a GeolocationPosition-compatible JSON object from an Android
     * Location so the JS layer can consume it without any transformation.
     */
    private fun locationJson(loc: Location) = JSONObject().apply {
        put("coords", JSONObject().apply {
            put("latitude", loc.latitude)
            put("longitude", loc.longitude)
            put("accuracy", loc.accuracy.toDouble())
            put("altitude", if (loc.hasAltitude()) loc.altitude else JSONObject.NULL)
            put("altitudeAccuracy", JSONObject.NULL)
            put("heading", JSONObject.NULL)
            put("speed", if (loc.hasSpeed()) loc.speed.toDouble() else JSONObject.NULL)
        })
        put("timestamp", loc.time)
    }

    private fun fetchLocation(callbackId: String, highAccuracy: Boolean) {
        if (!hasLocationPermission()) {
            pendingPositionRequests += callbackId to highAccuracy
            requestLocationPermission()
            return
        }

        val priority = if (highAccuracy)
            Priority.PRIORITY_HIGH_ACCURACY
        else
            Priority.PRIORITY_BALANCED_POWER_ACCURACY

        try {
            @SuppressLint("MissingPermission")
            val task = fusedLocationClient.lastLocation
            task.addOnSuccessListener { loc ->
                if (loc != null) {
                    deliverResult(callbackId, locationJson(loc))
                } else {
                    // No cached fix – request a fresh one.
                    @SuppressLint("MissingPermission")
                    val req = CurrentLocationRequest.Builder()
                        .setPriority(priority)
                        .setDurationMillis(30_000L)
                        .build()
                    fusedLocationClient.getCurrentLocation(req, null)
                        .addOnSuccessListener { fresh ->
                            if (fresh != null) deliverResult(callbackId, locationJson(fresh))
                            else deliverError(callbackId, 2, "Location unavailable")
                        }
                        .addOnFailureListener {
                            deliverError(callbackId, 2, "Location unavailable")
                        }
                }
            }
            task.addOnFailureListener {
                deliverError(callbackId, 2, "Location unavailable")
            }
        } catch (e: SecurityException) {
            deliverError(callbackId, 1, "Location permission denied")
        }
    }

    private fun startWatch(callbackId: String, highAccuracy: Boolean) {
        if (!hasLocationPermission()) return

        val priority = if (highAccuracy)
            Priority.PRIORITY_HIGH_ACCURACY
        else
            Priority.PRIORITY_BALANCED_POWER_ACCURACY

        val request = LocationRequest.Builder(priority, 5_000L)
            .setMinUpdateIntervalMillis(2_000L)
            .build()

        locationCallback = object : LocationCallback() {
            override fun onLocationResult(result: LocationResult) {
                val loc = result.lastLocation ?: return
                deliverResult(callbackId, locationJson(loc), persistent = true)
            }
        }

        try {
            @SuppressLint("MissingPermission")
            val task = fusedLocationClient.requestLocationUpdates(
                request, locationCallback!!, mainLooper,
            )
            task.addOnFailureListener {
                deliverError(callbackId, 2, "Location updates unavailable")
            }
        } catch (e: SecurityException) {
            deliverError(callbackId, 1, "Location permission denied")
        }
    }

    private fun clearWatchInternal() {
        locationCallback?.let { fusedLocationClient.removeLocationUpdates(it) }
        locationCallback = null
        watchCallbackId = null
    }

    // ── JavaScript interface ───────────────────────────────────────────

    inner class AndroidBridge {

        /**
         * Request a single position fix.
         * JS: Android.getCurrentPosition(callbackId, highAccuracy)
         */
        @JavascriptInterface
        fun getCurrentPosition(callbackId: String, highAccuracy: Boolean) {
            runOnUiThread { fetchLocation(callbackId, highAccuracy) }
        }

        /**
         * Start continuous position updates.
         * Android calls window._androidGeoCallback(callbackId, …) repeatedly
         * until clearWatch(callbackId) is invoked.
         * JS: Android.watchPosition(callbackId, highAccuracy)
         */
        @JavascriptInterface
        fun watchPosition(callbackId: String, highAccuracy: Boolean) {
            runOnUiThread {
                clearWatchInternal()
                watchCallbackId = callbackId
                if (!hasLocationPermission()) {
                    pendingWatchRequests += callbackId to highAccuracy
                    requestLocationPermission()
                } else {
                    startWatch(callbackId, highAccuracy)
                }
            }
        }

        /**
         * Stop the active position watch.
         * JS: Android.clearWatch(watchId)
         */
        @JavascriptInterface
        fun clearWatch(watchId: String) {
            runOnUiThread { clearWatchInternal() }
        }

        /**
         * Check current geolocation permission state.
         * Delivers {state: 'granted'|'prompt'} to JS.
         * JS: Android.checkPermissions(callbackId)
         */
        @JavascriptInterface
        fun checkPermissions(callbackId: String) {
            val state = if (hasLocationPermission()) "granted" else "prompt"
            deliverResult(callbackId, JSONObject().put("state", state))
        }

        /**
         * Request geolocation permission from the user.
         * Delivers {state: 'granted'|'denied'} to JS.
         * JS: Android.requestPermissions(callbackId)
         */
        @JavascriptInterface
        fun requestPermissions(callbackId: String) {
            runOnUiThread {
                if (hasLocationPermission()) {
                    deliverResult(callbackId, JSONObject().put("state", "granted"))
                } else {
                    pendingPermissionCallbacks += callbackId
                    requestLocationPermission()
                }
            }
        }
    }
}
