# Turtle graphics: a turtle walks around and draws a line wherever it goes.
# Change a number or a color and run it again!
import turtle

screen = turtle.Screen()
screen.bgcolor("midnight blue")

t = turtle.Turtle()
t.shape("turtle")
t.speed(10)  # 1 is slow, 10 is fast, 0 draws without animation
t.width(2)

# A spiral: every line is a bit longer than the one before, and every turn a
# bit less than 60 degrees, so the corners slowly twist around.
colors = ["red", "orange", "yellow", "lime", "deep sky blue", "violet"]
for i in range(72):
    t.pencolor(colors[i % len(colors)])
    t.forward(i * 3)
    t.left(59)

# A star in the middle: five lines, turning 144 degrees after each one.
t.penup()
t.goto(-60, 20)
t.setheading(0)
t.pendown()
t.color("gold", "yellow")  # pen color, fill color
t.begin_fill()
for _ in range(5):
    t.forward(120)
    t.right(144)
t.end_fill()

# Some words at the bottom.
t.penup()
t.goto(0, -280)
t.color("white")
t.write("Hello, turtle!", align="center", font=("Arial", 24, "bold"))
t.hideturtle()
