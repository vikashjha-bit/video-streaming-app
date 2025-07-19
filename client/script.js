const socket = new WebSocket('ws://localhost:3002');

let localStream;
let peerConnection;
let roomId = null; // To store the current room ID
let isCaller = false; // To determine who makes the offer first

const config = {
    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
};

// Get references to HTML elements
const localVideo = document.querySelector('#localVideo');
const remoteVideo = document.querySelector('#remoteVideo');
const roomIdInput = document.querySelector('#roomIdInput');
const joinButton = document.querySelector('#joinButton');
const messagesElement = document.querySelector('#messages');
const userNameInput = document.querySelector('#userNameInput');

function joinRoom() {
    const enteredRoomId = roomIdInput.value.trim();
    const userName = getUserName();
    if (!userName) {
        displayMessage('Please enter your name.', true, 'error');
        return;
    }
    if (!enteredRoomId) {
        displayMessage('Please enter a Room ID.', true, 'error');
        return;
    }

    navigator.mediaDevices.getUserMedia({ video: true, audio: true })
        .then(stream => {
            localStream = stream;
            localVideo.srcObject = localStream;
            displayMessage('Accessing camera and microphone...', false, 'system');
            socket.send(JSON.stringify({ type: 'joinRoom', roomId: enteredRoomId, name: userName }));
            displayMessage(`Requesting to join room: ${enteredRoomId} as ${userName}...`, false, 'user');
            joinButton.disabled = true;
            roomIdInput.disabled = true;
            userNameInput.disabled = true;
        })
        .catch(error => {
            console.error('Error accessing media devices:', error);
            displayMessage('Failed to access camera/microphone. Please ensure permissions are granted.', true, 'error');
        });
}

// --- UI Event Listeners ---
joinButton.addEventListener('click', joinRoom);

// --- WebSocket Event Handlers ---
socket.onopen = () => {
    console.log('WebSocket connected');
    displayMessage('Connected to signaling server.', false, 'system');
};

socket.onmessage = async (event) => {
    const raw = typeof event.data === 'string' ? event.data : await event.data.text();
    const data = JSON.parse(raw);
    console.log('Received message:', data.type, data);

    switch (data.type) {
        case 'room-joined':
            roomId = data.roomId;
            displayMessage(`You joined room: ${roomId}. Waiting for another user...`, false, 'user');
            break;
        case 'user-joined':
            if (data.name && data.name !== getUserName()) {
                displayMessage(`${data.name} has joined the room.`, false, 'user');
            } else {
                displayMessage(`Another user joined room ${roomId}.`, false, 'user');
            }
            if (data.isInitiator) {
                isCaller = true;
                await createPeerConnection();
                await makeOffer();
            } else {
                await createPeerConnection();
            }
            break;
        case 'offer':
            if (!peerConnection) {
                await createPeerConnection();
            }
            await handleOffer(data.offer);
            break;
        case 'answer':
            await handleAnswer(data.answer);
            break;
        case 'candidate':
            await handleCandidate(data.candidate);
            break;
        case 'user-left':
            if (data.name) {
                displayMessage(`${data.name} has left the room.`, true, 'user');
            } else {
                displayMessage('User left the room.', true, 'user');
            }
            if (peerConnection) {
                peerConnection.close();
                peerConnection = null;
            }
            remoteVideo.srcObject = null;
            break;
        case 'message':
            displayMessage(data.message, false, 'system');
            break;
        case 'error':
            displayMessage(`Error: ${data.message}`, true, 'error');
            break;
        default:
            console.warn('Unknown message type:', data.type);
    }
};

socket.onclose = () => {
    console.log('WebSocket disconnected');
    displayMessage('Disconnected from signaling server.', true, 'error');
    if (peerConnection) {
        peerConnection.close();
        peerConnection = null;
    }
    localVideo.srcObject = null;
    remoteVideo.srcObject = null;
    roomId = null;
};

socket.onerror = (error) => {
    console.error('WebSocket error:', error);
    displayMessage('WebSocket error occurred!', true, 'error');
};

// --- Helper for displaying messages ---
function displayMessage(message, isError = false, type = 'system') {
    messagesElement.textContent = message;
    messagesElement.className = 'msg';
    if (isError || type === 'error') messagesElement.classList.add('error');
    if (type === 'user') messagesElement.classList.add('user');
}

function getUserName() {
    return userNameInput ? userNameInput.value.trim() : '';
}

// --- WebRTC Logic ---
async function createPeerConnection() {
    if (peerConnection) { // Prevent creating multiple peer connections
        console.log('Peer connection already exists, reusing.');
        return;
    }
    peerConnection = new RTCPeerConnection(config);
    console.log('Created RTCPeerConnection');

    // Add local stream to peer connection
    if (localStream) {
        localStream.getTracks().forEach(track => {
            peerConnection.addTrack(track, localStream);
            console.log('Added local track:', track.kind);
        });
    } else {
        console.error('Local stream not available when creating peer connection.');
        displayMessage('Local media not available.', true);
        return;
    }

    // Handle ICE candidates
    peerConnection.onicecandidate = (event) => {
        if (event.candidate) {
            console.log('Sending ICE candidate:', event.candidate);
            socket.send(JSON.stringify({
                type: 'candidate',
                candidate: event.candidate,
                roomId: roomId // Important: send roomId with signaling
            }));
        }
    };

    // Handle remote tracks
    peerConnection.ontrack = (event) => {
        console.log('Received remote track:', event.track.kind);
        if (remoteVideo.srcObject !== event.streams[0]) {
            remoteVideo.srcObject = event.streams[0];
            displayMessage('Remote video stream received!', false);
        }
    };

    // Optional: Log connection state changes
    peerConnection.onconnectionstatechange = (event) => {
        console.log('PeerConnection state:', peerConnection.connectionState);
        displayMessage(`Connection state: ${peerConnection.connectionState}`, false);
    };
    peerConnection.oniceconnectionstatechange = (event) => {
        console.log('ICE connection state:', peerConnection.iceConnectionState);
        displayMessage(`ICE state: ${peerConnection.iceConnectionState}`, false);
    };
}

async function makeOffer() {
    try {
        const offer = await peerConnection.createOffer();
        await peerConnection.setLocalDescription(offer);
        console.log('Sending offer:', offer);
        socket.send(JSON.stringify({
            type: 'offer',
            offer: offer,
            roomId: roomId // Important: send roomId with signaling
        }));
    } catch (error) {
        console.error('Error creating or sending offer:', error);
        displayMessage('Failed to create/send offer.', true);
    }
}

async function handleOffer(offer) {
    try {
        // Ensure peerConnection is created before setting remote description
        if (!peerConnection) {
            await createPeerConnection();
        }

        await peerConnection.setRemoteDescription(new RTCSessionDescription(offer));
        console.log('Received and set remote offer.');

        const answer = await peerConnection.createAnswer();
        await peerConnection.setLocalDescription(answer);
        console.log('Sending answer:', answer);
        socket.send(JSON.stringify({
            type: 'answer',
            answer: answer,
            roomId: roomId // Important: send roomId with signaling
        }));
    } catch (error) {
        console.error('Error handling offer:', error);
        displayMessage('Failed to handle offer.', true);
    }
}

async function handleAnswer(answer) {
    try {
        await peerConnection.setRemoteDescription(new RTCSessionDescription(answer));
        console.log('Received and set remote answer.');
    } catch (error) {
        console.error('Error handling answer:', error);
        displayMessage('Failed to handle answer.', true);
    }
}

function handleCandidate(candidate) {
    try {
        peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
        console.log('Added ICE candidate.');
    } catch (error) {
        console.error('Error adding ICE candidate:', error);
        displayMessage('Failed to add ICE candidate.', true);
    }
}

const pauseCameraButton = document.querySelector('#pauseCameraButton');
let isCameraPaused = false;

pauseCameraButton.addEventListener('click', () => {
    if (!localStream) {
        displayMessage('Camera not active yet.', true);
        return;
    }

    localStream.getVideoTracks().forEach(track => {
        track.enabled = !track.enabled;
        isCameraPaused = !track.enabled;
    });

    pauseCameraButton.textContent = isCameraPaused ? 'Resume Camera' : 'Pause Camera';
    displayMessage(isCameraPaused ? 'Camera paused.' : 'Camera resumed.', false, 'system');
});


const muteRemoteButton = document.querySelector('#muteRemoteButton');
let isRemoteMuted = false;

muteRemoteButton.addEventListener('click', () => {
    if (!remoteVideo.srcObject) {
        displayMessage('Remote stream not available yet.', true);
        return;
    }

    const remoteAudioTracks = remoteVideo.srcObject.getAudioTracks();
    if (remoteAudioTracks.length === 0) {
        displayMessage('No remote audio track found.', true);
        return;
    }

    // Toggle audio tracks
    remoteAudioTracks.forEach(track => {
        track.enabled = !track.enabled;
        isRemoteMuted = !track.enabled;
    });

    muteRemoteButton.textContent = isRemoteMuted ? 'Unmute Remote' : 'Mute Remote';
    displayMessage(isRemoteMuted ? 'Remote user muted.' : 'Remote user unmuted.', false, 'system');
});
