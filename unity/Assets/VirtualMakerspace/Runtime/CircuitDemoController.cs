using VirtualMakerspace.Circuits;
using UnityEngine;

namespace VirtualMakerspace
{
    public sealed class CircuitDemoController : MonoBehaviour
    {
        [SerializeField] private Renderer ledRenderer;
        [SerializeField] private Color successColor = new Color(0.1f, 1f, 0.25f);
        [SerializeField] private Color inactiveColor = new Color(0.25f, 0.05f, 0.05f);

        private void Start()
        {
            var circuit = new CircuitDefinition();
            circuit.AddResistor(CircuitNode.PositiveRail, CircuitNode.RowA, 220);
            circuit.AddLed(CircuitNode.RowA, CircuitNode.RowB);
            circuit.AddConductor(CircuitNode.RowB, CircuitNode.NegativeRail);
            CircuitStatus status = circuit.Evaluate();
            ledRenderer.material.color = status == CircuitStatus.Complete ? successColor : inactiveColor;
            Debug.Log($"Virtual Makerspace circuit status: {status}");
        }
    }
}