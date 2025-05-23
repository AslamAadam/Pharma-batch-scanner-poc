// --- PoC Global Variables and UI Element References ---
const notifications = document.getElementById('notifications');
const textOverlay = document.getElementById('text-overlay'); // For our custom red/green barcode boxes
const barcodeScanCountElement = document.getElementById('barcode-scan-count');
const resultCtx = document.getElementById('cvs-result').getContext('2d');
const SCRIPT_URL = "https://script.google.com/macros/s/AKfycbwOVUTZDPPkl0d7cpc8Rq5p4cXf5hkxVd13gS3sr1xK1I1uVg7ZWRZmTSAlDEUj2mqTrA/exec"; 
const apiKey_Vision = null;                                     // <<< SET TO YOUR REAL GOOGLE VISION KEY TO ENABLE OCR, OR KEEP NULL
const DYNAMSOFT_LICENSE_KEY = "DLS2eyJoYW5kc2hha2VDb2RlIjoiMTA0MDEwMTA3LVRYbFhaV0pRY205cSIsIm1haW5TZXJ2ZXJVUkwiOiJodHRwczovL21kbHMuZHluYW1zb2Z0b25saW5lLmNvbSIsIm9yZ2FuaXphdGlvbklEIjoiMTA0MDEwMTA3Iiwic3RhbmRieVNlcnZlclVSTCI6Imh0dHBzOi8vc2Rscy5keW5hbXNvZnRvbmxpbmUuY29tIiwiY2hlY2tDb2RlIjozOTEyNzM1NDh9";  

let detectedBarcodes = []; // Stores barcodes from current scan session
let inventoryData = [];    // Loaded from Google Sheets, contains ItemID and Reported status
let lastVerificationResult = { nonReportedItems: [] }; // Stores result from Apps Script verification
let videoOverlayCtxPoc = null;
// Panorama/Batch SDK specific globals (from demo structure)
let dpsInstanceID;
let panoramaCamera = null; // Will be instance of DMCamera.Camera, initialized later
let batchSdkReady = false; // Flag for Panorama SDK initialization status
let dpsWorkerInitialized = false; // Flag for our internal worker communication helpers
let isPocScanning = false; // Controls our PoC's analyze/draw loop
let divsForNextPaint = [];

// --- PoC Helper Functions ---
function appendNotification(message, color = 'black') {
    if (!notifications) { console.warn("Notifications div not found for message:", message); return; }
    const el = document.createElement('p');
    el.style.color = color;
    el.textContent = message;
    notifications.appendChild(el);
    notifications.scrollTop = notifications.scrollHeight;
}

function checkHTTPS() {
    if (window.location.protocol !== 'https:' && window.location.hostname !== 'localhost' && window.location.hostname !== '127.0.0.1') {
        appendNotification("Error: HTTPS required for camera access (except localhost).", "red");
        return false;
    }
    return true;
}

function checkGetUserMediaSupport() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        appendNotification("Error: Camera access not supported by this browser.", "red");
        return false;
    }
    return true;
}

async function fetchInventoryData() {
    if (!SCRIPT_URL || SCRIPT_URL.startsWith("YOUR_")) {
        appendNotification("Apps Script URL not configured. Inventory features disabled.", "orange");
        inventoryData = [];
        return;
    }
    try {
        appendNotification("Fetching inventory data...", "grey");
        const response = await fetch(`${SCRIPT_URL}?action=getInventoryData`);
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`HTTP error fetching inventory! Status: ${response.status}. Response: ${errorText}`);
        }
        inventoryData = await response.json();
        appendNotification("Inventory data loaded successfully (" + (inventoryData.length || 0) + " items).", "blue");
    } catch (error) {
        console.error("Error fetching inventory data:", error);
        appendNotification(`Error fetching inventory data: ${error.message}`, "red");
        inventoryData = [];
    }
}

// === DPS/Panorama SDK Worker Communication Helper Functions (Taken from your provided dps.js demo) ===
// These are essential for the Panorama SDK to function with its Web Worker.
let ensureCallerCounter = 0; // For tracking calls

function ensureCoreWorkerHelpersInternal(callerName = "Unknown") {
    ensureCallerCounter++; // Keep this for logging
    //console.log(`ensureCoreWorkerHelpersInternal CALLED (${ensureCallerCounter}) by: ${callerName}.`);
    //console.log(`  Current Dynamsoft.Core.worker:`, window.Dynamsoft?.Core?.worker);
    //console.log(`  Current Dynamsoft.Core.mapTaskCallBack:`, window.Dynamsoft?.Core?.mapTaskCallBack);
    //console.log(`  Current Dynamsoft.Core.getNextTaskID:`, window.Dynamsoft?.Core?.getNextTaskID);

    // We now know worker is defined after loadWasm.
    // The bundle itself should be setting up mapTaskCallBack and getNextTaskID.
    // Let's just check if they exist.

    if (!window.Dynamsoft || !Dynamsoft.Core) {
        const msg = `ensureCoreWorkerHelpersInternal (${ensureCallerCounter}): Dynamsoft or Dynamsoft.Core not available.`;
        console.error(msg);
        throw new Error(msg);
    }

    if (!Dynamsoft.Core.worker) {
        const msg = `ensureCoreWorkerHelpersInternal (${ensureCallerCounter}): Dynamsoft.Core.worker IS UNDEFINED HERE. This is the problem.`;
        console.error(msg, "Current Dynamsoft.Core object:", Dynamsoft.Core);
        throw new Error(msg);
    }

    if (typeof Dynamsoft.Core.mapTaskCallBack !== 'object') {
        // It might be okay if it's null initially, but should be an object.
        // If this throws, it means the bundle didn't set it up.
        // Dynamsoft.Core.mapTaskCallBack = {}; // Avoid re-assigning if bundle manages it.
        //console.warn(`ensureCoreWorkerHelpersInternal (${ensureCallerCounter}): Dynamsoft.Core.mapTaskCallBack is not an object. Current value:`, Dynamsoft.Core.mapTaskCallBack, "Attempting to initialize.");
        Dynamsoft.Core.mapTaskCallBack = Dynamsoft.Core.mapTaskCallBack || {}; // Initialize only if truly undefined/null
    }

    if (typeof Dynamsoft.Core.getNextTaskID !== 'function') {
        // If this throws, it means the bundle didn't set it up.
        // Dynamsoft.Core._gTaskID = Dynamsoft.Core._gTaskID || 0; // Avoid re-assigning if bundle manages it.
        // Dynamsoft.Core.getNextTaskID = () => { /* ... */ };
        //console.warn(`ensureCoreWorkerHelpersInternal (${ensureCallerCounter}): Dynamsoft.Core.getNextTaskID is not a function. Current value:`, Dynamsoft.Core.getNextTaskID, "Attempting to initialize.");
        if (!Dynamsoft.Core.getNextTaskID) { // Initialize only if truly undefined
             Dynamsoft.Core._gTaskID = Dynamsoft.Core._gTaskID || 0;
             Dynamsoft.Core.getNextTaskID = () => {
                Dynamsoft.Core._gTaskID = (Dynamsoft.Core._gTaskID || 0) + 1;
                return Dynamsoft.Core._gTaskID;
            };
        }
    }
    
    // dpsWorkerInitialized flag might not be needed if we rely on the bundle's state.
    // If we keep it, ensure it's set appropriately.
    // For now, let's assume the bundle handles its own "initialized" state.
    // dpsWorkerInitialized = true; 
    console.log(`ensureCoreWorkerHelpersInternal (${ensureCallerCounter}): Checks passed.`);
}


// --- Copied Verbatim from your dps.js (renamed with _internal) ---
const dps_createInstance = async () => {
     ensureCoreWorkerHelpersInternal("dps_createInstance"); // Make sure helpers are ready
    let taskID = Dynamsoft.Core.getNextTaskID();
    return new Promise((rs, rj) => {
        Dynamsoft.Core.mapTaskCallBack[taskID] = (body) => {
            delete Dynamsoft.Core.mapTaskCallBack[taskID];
            if (body.success) {
                rs(body.instanceID);
            } else {
                const err = Error(body.message);
                if (body.stack) { err.stack = body.stack; }
                rj(err);
            }
        };
    Dynamsoft.Core.worker.postMessage({
      type: 'dps_createInstance',
      body: {},
      id: taskID,
    });
  });
}

const dps_initCVRSettings = async (dpsInstanceID, cvrSettings) => {  
    ensureCoreWorkerHelpersInternal("dps_initCVRSettings");
    let taskID = Dynamsoft.Core.getNextTaskID();
    return new Promise((rs, rj) => { 
        Dynamsoft.Core.mapTaskCallBack[taskID] = (body) => {
            delete Dynamsoft.Core.mapTaskCallBack[taskID];
            if (body.success) {
                rs(body.response)
            } else {
                const err = Error(body.message);
                if (body.stack) { err.stack = body.stack; }
                rj(err);
            }
        };
        Dynamsoft.Core.worker.postMessage({
            type: 'dps_initCVRSettings',
            instanceID: dpsInstanceID,
            body: {
                settings: cvrSettings,
            },
            id: taskID,
        });
    });
}

const dps_initSettings = async (dpsInstanceID, settings) => {  
    ensureCoreWorkerHelpersInternal("dps_initSettings"); 
    let settingsObj = JSON.parse(settings);
    if (settingsObj.PanoramaSettings && settingsObj.PanoramaSettings[0]) {
        settingsObj.PanoramaSettings[0].ThreadMode = 0;
  }
  settings = JSON.stringify(settingsObj);
  let taskID = Dynamsoft.Core.getNextTaskID();
  return new Promise((rs, rj) => { // Removed nested async
    Dynamsoft.Core.mapTaskCallBack[taskID] = (body) => {
      delete Dynamsoft.Core.mapTaskCallBack[taskID];
      if (body.success) {
        rs(body.response)
      } else {
        const err = Error(body.message);
        if (body.stack) { err.stack = body.stack; }
        rj(err);
      }
    };
    Dynamsoft.Core.worker.postMessage({
      type: 'dps_initSettings',
      instanceID: dpsInstanceID,
      body: {
        settings: settings,
      },
      id: taskID,
    });
  });
};

// This is our ADAPTED version of the demo's dps_stitchImage
// It focuses on getting landmark data from the current frame for our overlay
const dps_getFrameDetections = async (dpsInstanceID, cameraInstance) => {
    ensureCoreWorkerHelpersInternal("dps_getFrameDetections");
    if (!dpsInstanceID || !cameraInstance || cameraInstance.status !== 'opened') return null;

    const frameCvs = cameraInstance.getFrame();
    if (!frameCvs || !frameCvs.width || !frameCvs.height) {
        // console.warn("getFrameDetections: Invalid frame from camera.");
        return null;
    }
    const u8 = frameCvs.getContext("2d").getImageData(0, 0, frameCvs.width, frameCvs.height).data;
    if (!u8.length) {
        // console.warn('getFrameDetections: No image data in frame.');
        return null;
    }

    let taskID = Dynamsoft.Core.getNextTaskID();
    return new Promise((rs, rj) => {
        Dynamsoft.Core.mapTaskCallBack[taskID] = (body) => {
            delete Dynamsoft.Core.mapTaskCallBack[taskID];
            if (body.success) {
                rs(body.response); // Return the full response object from the worker
            } else {
                const err = Error(body.message); if (body.stack) err.stack = body.stack; rj(err);
            }
        };
        // This message type 'dps_setPanoramicBaseImage' comes from the demo's dps_stitchImage
        Dynamsoft.Core.worker.postMessage({
            type: 'dps_setPanoramicBaseImage',
            instanceID: dpsInstanceID,
            body: {
                bytes: u8, width: frameCvs.width, height: frameCvs.height,
                stride: frameCvs.width * 4, format: 10, // RGBA
                templateName: '' // Or 'Panorama_CVR' if linked to a template
            },
            id: taskID,
        });
    });
}

const dps_clean = async (dpsInstanceID) => {
    ensureCoreWorkerHelpersInternal("dps_clean");
  if (!dpsInstanceID) return;
  let taskID = Dynamsoft.Core.getNextTaskID();
  return new Promise((rs,rj)=>{ // Added return
    Dynamsoft.Core.mapTaskCallBack[taskID] = (body) => {
      delete Dynamsoft.Core.mapTaskCallBack[taskID];
      if (body.success) {
        rs()
      } else {
        const err = Error(body.message);
        if (body.stack) { err.stack = body.stack; }
        rj(err);
      }
    }
    Dynamsoft.Core.worker.postMessage({
      type: 'dps_clean',
      instanceID: dpsInstanceID,
      id: taskID,
    });
  });
}
// async function dps_deleteInstance_internal(dpsInstanceID) { ... } // If needed

// === End of Copied/Adapted DPS Worker Helpers ===


// --- Initialize Panorama/Batch SDK ---
async function initializePanoramaSDK() {
    //appendNotification("Attempting Panorama SDK initialization...", "grey");
    try {
        if (!window.Dynamsoft || !window.DMCamera) {
            throw new Error("Dynamsoft SDK or DMCamera not loaded. Check HTML script includes.");
        }
        
        //ensureCoreWorkerHelpersInternal();

        Dynamsoft.Core.CoreModule.engineResourcePaths.rootDirectory = './assets/';
        //appendNotification("Panorama SDK: Engine path set to ./assets/", "grey");

        await Dynamsoft.License.LicenseManager.initLicense(DYNAMSOFT_LICENSE_KEY, true);
        //appendNotification("Panorama SDK: License initialized.", "grey");

        await Dynamsoft.Core.CoreModule.loadWasm(["DBR"]);
        //appendNotification("Panorama SDK: DBR WASM loaded.", "grey");

        dpsInstanceID = await dps_createInstance();
        if (!dpsInstanceID) throw new Error("Failed to create DPS instance.");
        //appendNotification("Panorama SDK: DPS Instance created: " + dpsInstanceID, "grey");

        const cvrSettingsText = await fetch('./template_cvr.json').then(r => r.text());
        await dps_initCVRSettings(dpsInstanceID, cvrSettingsText);
        //appendNotification("Panorama SDK: CVR template loaded.", "grey");

        const panoramaSettingsText = await fetch('./template_panorama.json').then(r => r.text());
        await dps_initSettings(dpsInstanceID, panoramaSettingsText);
        //appendNotification("Panorama SDK: Panorama template loaded.", "grey");

        batchSdkReady = true; // Set our flag
        appendNotification("Panorama SDK: Initialized SUCCESSFULLY.", "blue");

    } catch (error) {
        console.error("Error initializing Panorama SDK:", error);
        appendNotification(`Panorama SDK Init Error: ${error.message || error}`, "red");
        batchSdkReady = false;
    }
    //console.log("initializePanoramaSDK complete. batchSdkReady is:", batchSdkReady);
}

// --- Process Panorama Landmarks for Barcode Boxes (Red/Green) ---
function processPanoramaLandmarksForPoC(landmarksArray, cameraInstance) {
    if (!Array.isArray(landmarksArray)) return ;

    landmarksArray.forEach(landmark => {
        try {
            const barcodeValue = landmark.text; // From demo: landmarksArray.map(l=>l.text)
            const location = landmark.location; // From demo: landmark.location.points

            if (!barcodeValue || !location || !location.points || location.points.length !== 4) {
                return;
            }

            let isReported = false;
            let itemFoundInInventory = false;
            if (Array.isArray(inventoryData) && inventoryData.length > 0) {
                const inventoryItem = inventoryData.find(item => item.ItemID === barcodeValue);
                if (inventoryItem) {
                    itemFoundInInventory = true;
                    if (inventoryItem.Reported && inventoryItem.Reported.toString().toLowerCase() === "yes") {
                        isReported = true;
                    }
                }
            }

            if (!detectedBarcodes.includes(barcodeValue)) {
                detectedBarcodes.push(barcodeValue);
                 if (barcodeScanCountElement) barcodeScanCountElement.textContent = detectedBarcodes.length;
                let nColor = isReported ? "green" : (itemFoundInInventory ? "darkorange" : "red");
                const formatString = landmark.barcodeFormatString || (landmark.format && Dynamsoft.DBR.EnumBarcodeFormat[landmark.format]) || "Unknown";
                appendNotification(`Barcode: ${barcodeValue} (${formatString})`, nColor);
            }

        } catch (loopError) {
            console.error("Error processing one PoC landmark:", loopError, landmark);
        }
    });
}

// --- Process Vision API for OCR output div (IF ENABLED LATER) ---
function processVisionApiResponseForOCR(response) {
    const ocrOutputElement = document.getElementById('ocr-output');
    let textForDisplay = "No text detected (Vision API).";
    let currentFrameTextList = []; // For global detectedText

    if (response.fullTextAnnotation && response.fullTextAnnotation.text) {
        textForDisplay = response.fullTextAnnotation.text;
        if (response.fullTextAnnotation.pages) {
            response.fullTextAnnotation.pages.forEach(p =>
                p.blocks?.forEach(b =>
                    b.paragraphs?.forEach(pg =>
                        pg.words?.forEach(w =>
                            currentFrameTextList.push(w.symbols?.map(s => s.text).join('') || '')
                        )
                    )
                )
            );
        }
    } else if (response.textAnnotations && response.textAnnotations.length > 0) {
        textForDisplay = response.textAnnotations[0].description;
        currentFrameTextList = response.textAnnotations.map(ta => ta.description.trim()).filter(Boolean);
    }

    if (ocrOutputElement) ocrOutputElement.textContent = textForDisplay;
    if (currentFrameTextList.length > 0) {
        detectedText = currentFrameTextList.map(t => t.trim()).filter(t => t);
    }
}

// --- Main Analysis and Drawing Loop (Using Panorama SDK) ---
async function pocAnalyzeAndDrawLoop() {
    if (!isPocScanning || !dpsInstanceID || !panoramaCamera || panoramaCamera.status !== 'opened' || !dpsInstanceID) {
        // If stopping, clear the canvas overlay
        if (videoOverlayCtxPoc) {
            videoOverlayCtxPoc.clearRect(0, 0, videoOverlayCtxPoc.canvas.width, videoOverlayCtxPoc.canvas.height);
        }
        // And also clear the old HTML text overlay (if it has anything)
        //if (textOverlay) textOverlay.innerHTML = '';
        return;
    }

    let liveFrameLandmarksForOverlay = [];
        try {
        const panoramaSdkResult = await dps_getFrameDetections(dpsInstanceID, panoramaCamera);
        //console.log("Full Panorama SDK Result:",
          //  JSON.parse(JSON.stringify(panoramaSdkResult)))
        if (panoramaSdkResult) {
            const liveLandmarks = panoramaSdkResult.frameMappedResult?.landmarksArray;
            if (liveLandmarks && liveLandmarks.length > 0) {
                // Update notifications and the main 'detectedBarcodes' list with these live findings
                processPanoramaLandmarksForPoC(liveLandmarks, panoramaCamera); 
                // Store these landmarks to be drawn on the live camera feed's overlay
                liveFrameLandmarksForOverlay = liveLandmarks; 
            }

            // --- 2. Process results for the STITCHED panorama (on cvs-result canvas) ---
            // This is where all barcodes found on the larger, stitched image are.
            if (panoramaSdkResult.capturedPanoramaArray && panoramaSdkResult.capturedPanoramaArray[0]) {
                const stitchedPanoramaData = panoramaSdkResult.capturedPanoramaArray[0];
                const stitchedImage = stitchedPanoramaData.image; // The actual stitched image data
                const stitchedLandmarks = stitchedPanoramaData.landmarksArray; // All barcodes on stitched image

                // --- 2a. Display the stitched image itself on cvs-result (OPTIONAL but recommended) ---
                if (stitchedImage && resultCtx) { // resultCtx is the context for 'cvs-result'
                    const resultCvs = resultCtx.canvas; // The <canvas> element for cvs-result

                    // Adjust canvas dimensions if the stitched image size changes
                    if (resultCvs.width !== stitchedImage.width) { resultCvs.width = stitchedImage.width; }
                    if (resultCvs.height !== stitchedImage.height) { resultCvs.height = stitchedImage.height; }
                    
                    // The stitchedImage.bytes from Dynamsoft are often in BGR format.
                    // HTML Canvas needs RGBA. So, we convert.
                    const bgrBytes = stitchedImage.bytes;
                    const rgbaBytes = new Uint8ClampedArray(stitchedImage.height * stitchedImage.width * 4);
                    for (let i = 0, length = stitchedImage.height * stitchedImage.width; i < length; ++i) {
                        rgbaBytes[i * 4 + 2] = bgrBytes[i * 3];     // Blue channel
                        rgbaBytes[i * 4 + 1] = bgrBytes[i * 3 + 1]; // Green channel
                        rgbaBytes[i * 4 + 0] = bgrBytes[i * 3 + 2]; // Red channel
                        rgbaBytes[i * 4 + 3] = 255;                 // Alpha channel (fully opaque)
                    }
                    // Draw the converted image data onto the cvs-result canvas
                    resultCtx.putImageData(new ImageData(rgbaBytes, stitchedImage.width, stitchedImage.height), 0, 0);
                }

                // --- 2b. Draw ALL barcode bounding boxes from the stitched panorama onto cvs-result ---
                if (stitchedLandmarks && stitchedLandmarks.length > 0 && resultCtx) {
                    // If we didn't draw the stitched image above (e.g., if stitchedImage was null),
                    // we should clear the cvs-result canvas first to remove old drawings.
                    if (!stitchedImage) {
                         resultCtx.clearRect(0, 0, resultCtx.canvas.width, resultCtx.canvas.height);
                    }

                    stitchedLandmarks.forEach(landmark => {
                        let boxStyle = { 
                            fill: 'rgba(50, 205, 50, 0.3)',  // Default style: Reported (Green)
                            stroke: 'limegreen',
                            textFill: 'darkgreen'         // Color for the barcode text
                        };

                        // Check if lastVerificationResult and its arrays exist before trying to access them
                        if (lastVerificationResult) {
                            if (lastVerificationResult.notInInventory && 
                                lastVerificationResult.notInInventory.includes(landmark.text)) {
                                // Item was not found in the master inventory at all
                                boxStyle = { 
                                    fill: 'rgba(220, 53, 69, 0.4)',  // Distinct Red for "Not in Inventory"
                                    stroke: '#dc3545',               // Darker red border
                                    textFill: '#b02a37'              // Dark red text
                                };
                            } else if (lastVerificationResult.notReportedButInInventory && 
                                       lastVerificationResult.notReportedButInInventory.includes(landmark.text)) {
                                // Item is in inventory, but its "Reported" status is not "Yes"
                                boxStyle = { 
                                    fill: 'rgba(255, 193, 7, 0.4)', // Orange/Yellow for "In Inv, Not Reported"
                                    stroke: '#ffc107',              // Darker orange/yellow border
                                    textFill: '#c69500'             // Dark orange/yellow text
                                };
                            }
                            // If neither of the above, it remains the default green 'reported' style
                        }

                        // Set drawing styles based on whether it's reported
                       resultCtx.fillStyle = boxStyle.fill;
                        resultCtx.strokeStyle = boxStyle.stroke; 
                        resultCtx.lineWidth = 3; // Make lines a bit thicker for visibility

                        const p = landmark.location.points; // These coordinates are for the stitched image

                        // Draw the bounding box polygon
                        resultCtx.beginPath();
                        resultCtx.moveTo(p[0].x, p[0].y);
                        for (let i = 1; i < p.length; i++) {
                            resultCtx.lineTo(p[i].x, p[i].y);
                        }
                        resultCtx.closePath();
                        resultCtx.fill();   // Fill the shape
                        resultCtx.stroke(); // Draw the border

                        // Optional: Draw the barcode text near the box on cvs-result
                        resultCtx.fillStyle = boxStyle.textFill; // Text color
                        resultCtx.font = 'bold 16px Arial'; // Adjust font size as needed
                        // Position text slightly above the first point of the barcode
                        resultCtx.fillText(landmark.text.substring(0, 15), p[0].x, p[0].y - 7); 
                    });
                }
                
                // --- 2c. Ensure all barcodes from the stitched panorama are processed for notifications ---
                // This updates the `detectedBarcodes` list and global notifications
                // if any new unique barcodes were found in the latest stitched result.
                processPanoramaLandmarksForPoC(stitchedLandmarks, panoramaCamera);
            }
        }
    } catch (error) {
        console.error("Error in Panorama SDK frame processing in pocAnalyzeAndDrawLoop:", error);
    }


    // Google Vision API call (currently disabled by apiKey_Vision = null at top of file)
    if (apiKey_Vision && panoramaCamera.status === 'opened') {
        const visionFrameCanvas = panoramaCamera.getFrame(); // Get current frame from DMCamera
        if (visionFrameCanvas && visionFrameCanvas.width > 0) {
            const imageDataURL_vision = visionFrameCanvas.toDataURL('image/jpeg', 0.7);
            const imageDataBase64_vision = imageDataURL_vision.split(',')[1];

            fetch(`https://vision.googleapis.com/v1/images:annotate?key=${apiKey_Vision}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    requests: [{
                        image: { content: imageDataBase64_vision },
                        features: [{ type: 'DOCUMENT_TEXT_DETECTION' }] // Only OCR for now
                    }]
                })
            })
            .then(res => {
                if (!res.ok) {
                    res.text().then(text => { // Get error text if possible
                        console.error("Vision API HTTP Error:", res.status, text);
                        appendNotification(`Vision API Error (${res.status})`, "red");
                    });
                    return null; // Indicate error
                }
                return res.json();
            })
            .then(data => {
                if (data && data.responses && data.responses[0]) {
                    processVisionApiResponseForOCR(data.responses[0]);
                } else if (data && data.error) {
                     appendNotification(`Vision API Data Error: ${data.error.message}`, "red");
                }
            })
            .catch(err => console.error("Vision API fetch exception in loop:", err));
        }
    }
    
    if (isPocScanning) {
        // Pass the landmarks to paintOverlayPoc, which will then call the canvas drawing function
        requestAnimationFrame(() => paintOverlayPoc(liveFrameLandmarksForOverlay));
    }
}
// --- Paint Overlay Function (for real-time drawing) ---
function paintOverlayPoc(landmarksForLiveOverlay) {
    if (!textOverlay) textOverlay.innerHTML = ''; // Clear previous frame's custom boxes
    
    if (panoramaCamera) { // Ensure camera object exists
         drawBarcodesOnCanvasOverlay(landmarksForLiveOverlay, panoramaCamera);
    }

    if (isPocScanning) {
        setTimeout(() => {
            // Call pocAnalyzeAndDrawLoop to get the next frame's data and process it
            requestAnimationFrame(pocAnalyzeAndDrawLoop);
        }, 30); // 30ms delay, roughly 33fps for the loop
    }
}

// --- Event Listeners Setup ---
function setupPocEventListeners() {
    //console.log("Setting up PoC event listeners...");

    const startButton = document.getElementById('btn-start'); // Using demo's ID
    if (startButton) {
        startButton.addEventListener('click', async () => {
            //appendNotification("'Start/Pause Scan' button CLICKED!", "grey");
            if (!checkHTTPS()) { return; }
            if (!batchSdkReady) {
                appendNotification("Panorama SDK not ready. Please wait or check console for init errors.", "red");
                // Optionally try to re-initialize if it failed, or guide user to refresh.
                // await initializePanoramaSDK();
                // if (!batchSdkReady) return;
                return;
            }

            if (!panoramaCamera) {
                try {
                    panoramaCamera = new DMCamera.Camera();
                    const overlayCanvas = panoramaCamera.addCanvas(); // Ask DMCamera for its overlay canvas
        videoOverlayCtxPoc = overlayCanvas.getContext('2d'); // Get the 2D drawing context
                    const cameraViewContainer = document.getElementById('scanner-ui-container');
                    if (cameraViewContainer) {
                        Object.assign(panoramaCamera._coreWrapper.style, {
                            width: '100%', height: '100%', position: 'absolute',
                            top: '0px', left: '0px', zIndex: '1'
                        });
                        cameraViewContainer.appendChild(panoramaCamera._coreWrapper);
                        if (textOverlay) textOverlay.style.zIndex = '3';
                    } else {
                        console.error("#scanner-ui-container not found! Cannot place camera view.");
                        appendNotification("Error: Camera view container not found in HTML.", "red");
                        return;
                    }
                } catch (camError) {
                    console.error("Failed to create DMCamera instance:", camError);
                    appendNotification("Failed to create camera view: " + camError.message, "red");
                    return;
                }
            }

            if (panoramaCamera.status === 'closed' || panoramaCamera.status === 'paused') {
                try {
                    await panoramaCamera.open();
                    appendNotification("Camera opened by Panorama SDK.", "blue");
                    isPocScanning = true;
                    startButton.textContent = "Pause Scan";
                    document.getElementById('btn-stop').disabled = false;
                    detectedBarcodes = []; // Reset for new session
                    if (barcodeScanCountElement) barcodeScanCountElement.textContent = "0";
                    const ocrEl = document.getElementById('ocr-output');
                    if (ocrEl) ocrEl.textContent = 'Scanning for barcodes...';
                    // appendNotification("Scanning started...", "blue"); // Already covered by ocrEl
                    requestAnimationFrame(pocAnalyzeAndDrawLoop); // Kick off the analysis->paint loop
                } catch (ex) {
                    console.error("Error opening Panorama camera:", ex);
                    appendNotification(`Camera Open Error: ${ex.message || ex}`, "red");
                    isPocScanning = false; // Ensure scanning doesn't proceed
                }
            } else if (panoramaCamera.status === 'opened') {
                panoramaCamera.pause();
                isPocScanning = false; // Stop our processing loop
                startButton.textContent = "Resume Scan";
                appendNotification("Scan paused.", "orange");
            }
        });

        //console.log("Event listener attached to 'btn-start'.");
    } else { console.error("Button 'btn-start' not found!"); }

    const stopButton = document.getElementById('btn-stop'); // Using demo's ID
    if (stopButton) {
        stopButton.addEventListener('click', async () => {
            //appendNotification("'Stop Scan' button CLICKED!", "grey");
            isPocScanning = false; // Crucial to stop the loop

            const startBtn = document.getElementById('btn-start');
            if(startBtn) {
                startBtn.textContent = "Start Scan";
                startBtn.disabled = false;
            }
            stopButton.disabled = true;

            if (panoramaCamera && panoramaCamera.status !== 'closed') {
                await panoramaCamera.close(); // Properly close the DMCamera
                appendNotification("Panorama Camera closed.", "blue");
            }
            if (dpsInstanceID) {
                try {
                    await dps_clean(dpsInstanceID);
                    appendNotification("Panorama SDK instance cleaned.", "grey");
                } catch (e) { console.error("Error cleaning DPS instance: ", e); }
            }
            if (videoOverlayCtxPoc) { // Clear our PoC's canvas overlay
            videoOverlayCtxPoc.clearRect(0, 0, videoOverlayCtxPoc.canvas.width, videoOverlayCtxPoc.canvas.height);}

            if (resultCtx) { // resultCtx is the context for 'cvs-result'
            resultCtx.clearRect(0, 0, resultCtx.canvas.width, resultCtx.canvas.height);
        }

            appendNotification("Scanning stopped.", "blue");
             const ocrEl = document.getElementById('ocr-output');
            if (ocrEl) ocrEl.textContent = 'No text detected yet.';
        });
        //console.log("Event listener attached to 'btn-stop'.");
    } else { console.error("Button 'btn-stop' not found!"); }

    const sendButton = document.getElementById('send-to-sheets');
    if (sendButton) {
        sendButton.addEventListener('click', async () => {
            //console.log("'Send to Google Sheets' button CLICKED!");
            const invoiceInputElement = document.getElementById('invoice-id-input');
            if (!invoiceInputElement) { appendNotification("Invoice ID input not found!", "red"); return; }
            const invoiceID = invoiceInputElement.value.trim();

            if (detectedBarcodes.length === 0) { appendNotification("No barcodes scanned to send.", "orange"); return; }
            if (!invoiceID) { appendNotification("Please enter an Invoice ID.", "orange"); return; }
            if (!SCRIPT_URL || SCRIPT_URL.startsWith("YOUR_")) { appendNotification("Apps Script URL not configured.", "red"); return; }

            appendNotification(`Sending ${detectedBarcodes.length} barcodes for Invoice ${invoiceID}...`, "blue");
            try {
                const response = await fetch(SCRIPT_URL, {
                    method: 'POST',
                    // No Content-Type header for simpler GAS CORS handling with stringified JSON
                    body: JSON.stringify({ action: "saveBarcodes", barcodes: detectedBarcodes, invoiceID: invoiceID })
                });
                const resultText = await response.text();
                if (resultText === "Success") {
                    appendNotification(`Barcodes for Invoice ${invoiceID} sent successfully.`, "blue");
                } else {
                    appendNotification(`Error sending barcodes: ${resultText}`, "red");
                }
            } catch (error) {
                console.error("Fetch error in 'Send to Google Sheets':", error);
                appendNotification(`Network Error (Send to Sheets): ${error.message}`, "red");
            }
        });
        //console.log("Listener for 'send-to-sheets' attached.");
    } else { console.error("'send-to-sheets' button not found!"); }

    const verifyButton = document.getElementById('verify-items');
    if (verifyButton) {
        verifyButton.addEventListener('click', async () => {
            //console.log("'Verify Items' button CLICKED!");
            const invoiceInputElement = document.getElementById('invoice-id-input');
            if (!invoiceInputElement) { appendNotification("Invoice ID input not found!", "red"); return; }
            const invoiceID = invoiceInputElement.value.trim();

            if (!invoiceID) { appendNotification("Please enter an Invoice ID to verify.", "orange"); return; }
            if (!SCRIPT_URL || SCRIPT_URL.startsWith("YOUR_")) { appendNotification("Apps Script URL not configured.", "red"); return; }
            
           if (!detectedBarcodes || !Array.isArray(detectedBarcodes) || detectedBarcodes.length === 0) {
                appendNotification("No barcodes currently scanned/available to verify.", "orange");
                return; 
            }

            appendNotification(`Verifying ${detectedBarcodes.length} currently scanned items for Invoice ${invoiceID}...`, "blue");
            console.log("CLIENT: About to verify. detectedBarcodes:",JSON.stringify(detectedBarcodes), "Type:", typeof detectedBarcodes, "IsArray:", Array.isArray(detectedBarcodes));
            try {
                const response = await fetch(SCRIPT_URL, {
                    method: 'POST',
                    body: JSON.stringify({ action: "verifyItems", invoiceID: invoiceID, barcodesToVerify: detectedBarcodes })
                });
                if (!response.ok) {
                     const errorText = await response.text();
                     throw new Error(`Verification request failed (${response.status}): ${errorText}`);
                }
                const resultData = await response.json();
                lastVerificationResult = resultData; 
                appendNotification(resultData.message, "blue"); 

                let problemsFound = false;

                if (resultData.notInInventory && resultData.notInInventory.length > 0) {
                    appendNotification(`CRITICAL - ITEMS NOT FOUND IN INVENTORY: ${resultData.notInInventory.join(", ")}`, "red"); // Use a strong error color
                    problemsFound = true;
                }

                if (resultData.notReportedButInInventory && resultData.notReportedButInInventory.length > 0) {
                    appendNotification(`WARNING - Items in Inventory but NOT 'Reported=Yes': ${resultData.notReportedButInInventory.join(", ")}`, "orange"); // Warning color
                    problemsFound = true;
                }
                if (detectedBarcodes.length > 0 && !problemsFound) {
                    // This condition implies all items in barcodesToVerify were in resultData.reportedItems
                    appendNotification("All items in the current batch are correctly reported.", "green");
                } else if (detectedBarcodes.length === 0) {
                    // This case should ideally be caught before sending to GAS, but good to handle
                    appendNotification("No items were submitted in the current batch for verification.", "grey");
                }

                const allProblematicItems = [
                    ...(resultData.notInInventory || []), 
                    ...(resultData.notReportedButInInventory || [])
                ];

            } catch (error) {
                console.error("Fetch error in 'Verify Items':", error);
                appendNotification(`Error verifying items: ${error.message}`, "red");
            }
        });
        //console.log("Listener for 'verify-items' attached.");
    } else { console.error("'verify-items' button not found!"); }
}

function drawBarcodesOnCanvasOverlay(landmarksArray, cameraInstance) {
    if (!videoOverlayCtxPoc || !Array.isArray(landmarksArray) || !cameraInstance || panoramaCamera.status !== 'opened') {
        if (videoOverlayCtxPoc) { // If context exists but shouldn't draw, clear it
             videoOverlayCtxPoc.clearRect(0, 0, videoOverlayCtxPoc.canvas.width, videoOverlayCtxPoc.canvas.height);
        }
        return;
    }

    // Clear the canvas from the previous frame
    videoOverlayCtxPoc.clearRect(0, 0, videoOverlayCtxPoc.canvas.width, videoOverlayCtxPoc.canvas.height);

    landmarksArray.forEach(landmark => {
        try {
            const barcodeValue = landmark.text;
            const location = landmark.location;
            const p = location?.points; 

            if (!barcodeValue || !p || p.length !== 4) {
                return; // Skip incomplete landmarks
            }

             let boxStyle = { 
                fill: 'rgba(50, 205, 50, 0.3)',  // Default: Reported (Green)
                stroke: 'limegreen'
                // Text on live overlay can be cluttered, so textFill is optional here
            };

            if (lastVerificationResult) { // Check if verification has even happened
                if (lastVerificationResult.notInInventory && 
                    lastVerificationResult.notInInventory.includes(barcodeValue)) {
                    boxStyle = { 
                        fill: 'rgba(220, 53, 69, 0.4)',  // Not in Inventory (Red)
                        stroke: '#dc3545'
                    };
                } else if (lastVerificationResult.notReportedButInInventory && 
                           lastVerificationResult.notReportedButInInventory.includes(barcodeValue)) {
                    boxStyle = { 
                        fill: 'rgba(255, 193, 7, 0.4)', // In Inventory, Not Reported (Orange/Yellow)
                        stroke: '#ffc107'
                    };
                }
            }

            videoOverlayCtxPoc.fillStyle = boxStyle.fill;
            videoOverlayCtxPoc.strokeStyle = boxStyle.stroke;
            videoOverlayCtxPoc.lineWidth = 2; // A bit thicker lines


            videoOverlayCtxPoc.beginPath();
            videoOverlayCtxPoc.moveTo(p[0].x, p[0].y);
            for (let i = 1; i < p.length; i++) {
                videoOverlayCtxPoc.lineTo(p[i].x, p[i].y);
            }
            videoOverlayCtxPoc.closePath();
            videoOverlayCtxPoc.fill();
            videoOverlayCtxPoc.stroke();

            // Optional: Draw barcode text on the canvas (can get cluttered)
            // videoOverlayCtxPoc.fillStyle = isReported ? 'green' : 'red';
            // videoOverlayCtxPoc.font = 'bold 14px Arial';
            // videoOverlayCtxPoc.fillText(barcodeValue.substring(0, 10), p[0].x, p[0].y - 5); // Adjust position as needed

        } catch (loopError) {
            console.error("Error drawing one landmark on canvas overlay:", loopError, landmark);
        }
    });
} 

// --- Main PoC Initialization ---
async function pocMainInit() {

    if (window.Dynamsoft && window.Dynamsoft.Core) {

    } else {
        console.log("window.Dynamsoft or Dynamsoft.Core not yet defined at pocMainInit start."); 
    }

    if (!checkHTTPS()) { return; } // Stop if not HTTPS
    if (!checkGetUserMediaSupport()) { return; } // Stop if no camera support

    setupPocEventListeners(); // Setup listeners for ALL buttons
    await fetchInventoryData();

    setTimeout(async () => { // Introduce a delay
        
    await initializePanoramaSDK(); // Initialize the Panorama SDK

    appendNotification("App initialized. Click 'Start / Pause Scan' to begin.", "blue");

    // Initialize button states
    const startBtn = document.getElementById('btn-start');
    const stopBtn = document.getElementById('btn-stop');
    if (startBtn) startBtn.disabled = !batchSdkReady;
    if (stopBtn) stopBtn.disabled = true;
},500);
}

// Call the main PoC initialization function when the script loads
document.addEventListener('DOMContentLoaded', () => {
    //console.log("DOM fully loaded. Starting PoC main initialization...");
    pocMainInit();
});