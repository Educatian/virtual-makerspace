using NUnit.Framework;
using VirtualMakerspace.Circuits;

namespace VirtualMakerspace.Tests
{
    public sealed class CircuitEvaluatorTests
    {
        [Test]
        public void Evaluate_ReturnsComplete_WhenLedCircuitIsClosedAndCurrentLimited()
        {
            // Given
            var circuit = new CircuitDefinition();
            circuit.AddResistor(CircuitNode.PositiveRail, CircuitNode.RowA, 220);
            circuit.AddLed(CircuitNode.RowA, CircuitNode.RowB);
            circuit.AddConductor(CircuitNode.RowB, CircuitNode.NegativeRail);

            // When
            var result = circuit.Evaluate();

            // Then
            Assert.That(result, Is.EqualTo(CircuitStatus.Complete));
        }

        [Test]
        public void Evaluate_ReturnsReversedLed_WhenLedPolarityIsBackward()
        {
            // Given
            var circuit = new CircuitDefinition();
            circuit.AddResistor(CircuitNode.PositiveRail, CircuitNode.RowA, 220);
            circuit.AddLed(CircuitNode.RowB, CircuitNode.RowA);
            circuit.AddConductor(CircuitNode.RowB, CircuitNode.NegativeRail);

            // When
            var result = circuit.Evaluate();

            // Then
            Assert.That(result, Is.EqualTo(CircuitStatus.ReversedLed));
        }

        [Test]
        public void Evaluate_ReturnsMissingCurrentLimiter_WhenLedHasNoResistance()
        {
            // Given
            var circuit = new CircuitDefinition();
            circuit.AddConductor(CircuitNode.PositiveRail, CircuitNode.RowA);
            circuit.AddLed(CircuitNode.RowA, CircuitNode.RowB);
            circuit.AddConductor(CircuitNode.RowB, CircuitNode.NegativeRail);

            // When
            var result = circuit.Evaluate();

            // Then
            Assert.That(result, Is.EqualTo(CircuitStatus.MissingCurrentLimiter));
        }

        [Test]
        public void Evaluate_ReturnsOpenCircuit_WhenReturnPathIsMissing()
        {
            // Given
            var circuit = new CircuitDefinition();
            circuit.AddResistor(CircuitNode.PositiveRail, CircuitNode.RowA, 220);
            circuit.AddLed(CircuitNode.RowA, CircuitNode.RowB);

            // When
            var result = circuit.Evaluate();

            // Then
            Assert.That(result, Is.EqualTo(CircuitStatus.OpenCircuit));
        }
    }
}
