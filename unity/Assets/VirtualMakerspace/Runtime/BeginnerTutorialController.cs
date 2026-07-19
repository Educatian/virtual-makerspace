using System.IO;
using UnityEngine;
using UnityEngine.InputSystem;
using UnityEngine.UI;
using UnityEngine.Video;

namespace VirtualMakerspace
{
    public sealed class BeginnerTutorialController : MonoBehaviour
    {
        [SerializeField] private Text stepCounter;
        [SerializeField] private Text stepTitle;
        [SerializeField] private Text stepBody;
        [SerializeField] private Text buttonHint;
        [SerializeField] private VideoPlayer videoPlayer;

        private readonly string[] titles =
        {
            "Welcome to the Virtual Makerspace",
            "Grab a component",
            "Place it in a breadboard socket",
            "Collaborate, test, and explain"
        };

        private readonly string[] bodies =
        {
            "Watch the quick-start video. Keep both controllers visible and use the highlighted button cue below.",
            "Point your hand at a resistor or LED. Hold the INDEX TRIGGER to pick it up. Move slowly until the part follows your hand.",
            "Move the part over a glowing socket. When it aligns, release the INDEX TRIGGER. The shared board confirms the placement for both learners.",
            "Speak naturally with your partner. Use A or X to hand off the next step, test the circuit, and explain why the result occurred."
        };

        private InputAction nextAction;
        private InputAction previousAction;
        private int currentStep;

        private void Awake()
        {
            nextAction = new InputAction("Tutorial Next", InputActionType.Button);
            nextAction.AddBinding("<XRController>{LeftHand}/primaryButton");
            nextAction.AddBinding("<XRController>{RightHand}/primaryButton");
            nextAction.AddBinding("<Keyboard>/space");

            previousAction = new InputAction("Tutorial Back", InputActionType.Button);
            previousAction.AddBinding("<XRController>{LeftHand}/secondaryButton");
            previousAction.AddBinding("<XRController>{RightHand}/secondaryButton");
            previousAction.AddBinding("<Keyboard>/backspace");

            videoPlayer.url = Path.Combine(Application.streamingAssetsPath, "BeginnerTutorial.mp4");
            videoPlayer.isLooping = true;
            videoPlayer.playOnAwake = false;
            ShowStep(0);
        }

        private void OnEnable()
        {
            nextAction.performed += OnNext;
            previousAction.performed += OnPrevious;
            nextAction.Enable();
            previousAction.Enable();
            videoPlayer.Play();
        }

        private void OnDisable()
        {
            nextAction.performed -= OnNext;
            previousAction.performed -= OnPrevious;
            nextAction.Disable();
            previousAction.Disable();
            videoPlayer.Pause();
        }

        private void OnDestroy()
        {
            nextAction.Dispose();
            previousAction.Dispose();
        }

        private void OnNext(InputAction.CallbackContext context)
        {
            ShowStep(Mathf.Min(currentStep + 1, titles.Length - 1));
        }

        private void OnPrevious(InputAction.CallbackContext context)
        {
            ShowStep(Mathf.Max(currentStep - 1, 0));
        }

        private void ShowStep(int index)
        {
            currentStep = index;
            stepCounter.text = $"STEP {currentStep + 1} / {titles.Length}";
            stepTitle.text = titles[currentStep];
            stepBody.text = bodies[currentStep];
            buttonHint.text = currentStep == titles.Length - 1
                ? "A / X  REPEAT STEP     B / Y  BACK     INDEX TRIGGER  START BUILDING"
                : "A / X  NEXT     B / Y  BACK";
        }
    }
}